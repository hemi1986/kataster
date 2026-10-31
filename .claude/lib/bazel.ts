/**
 * Bazel adapter.
 *
 * A Bazel repository has no manifests to read: its packages are directories with a `BUILD`/`BUILD.bazel`
 * file, and its dependency edges are the `deps` attributes inside those files. `repo-map.ts` uses the BUILD
 * files directly – no Bazel server, no toolchain, no network – which keeps the map deterministic and fast
 * even on a machine that cannot build the repository.
 *
 * `bazel query 'deps(//...)'` would return the *target* closure instead; the package-level `deps` attributes
 * are what a slice needs and what the tool itself uses to decide visibility.
 *
 * Edge direction: `{ from, to }` means **from depends on to**.
 *
 * Node >= 22.18, erasable TypeScript only, no runtime dependency.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import type { GraphPackage, ToolGraph } from "./toolgraph.ts";

const IGNORED = new Set([
  "node_modules", "dist", "build", "out", "coverage", ".git", ".claude", ".opencode", ".kataster",
  "vendor", "target", "tmp", "temp",
]);
const BUILD_FILES = new Set(["BUILD", "BUILD.bazel"]);
const MAX_BUILD_FILES = 2000;

/** `./apps/a/` → `apps/a`; `""` and `"."` → `"."`. */
function normalizePackagePath(path: string): string {
  const trimmed = path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  return trimmed === "" || trimmed === "." ? "." : trimmed;
}

export interface BuildFile {
  /** Repository-relative directory of the BUILD file. */
  path: string;
  text: string;
}

/** Every BUILD/BUILD.bazel directory, sorted, capped so a huge monorepo stays fast. */
export function findBuildFiles(root: string, limit = MAX_BUILD_FILES): { path: string; file: string }[] {
  const out: { path: string; file: string }[] = [];
  const walk = (dir: string, depth: number): void => {
    if (out.length >= limit || depth > 24) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (IGNORED.has(entry.name) || entry.name.startsWith(".") || entry.name.startsWith("bazel-")) continue;
        walk(join(dir, entry.name), depth + 1);
      } else if (entry.isFile() && BUILD_FILES.has(entry.name)) {
        out.push({ path: dir, file: entry.name });
      }
    }
  };
  walk(root, 0);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** Removes `#` comments without touching `#` inside string literals. */
function stripComments(text: string): string {
  let out = "";
  let quote = "";
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      out += c;
      if (c === "\\") {
        out += text[i + 1] ?? "";
        i += 1;
      } else if (c === quote) {
        quote = "";
      }
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      out += c;
      continue;
    }
    if (c === "#") {
      while (i < text.length && text[i] !== "\n") i += 1;
      out += "\n";
      continue;
    }
    out += c;
  }
  return out;
}

/** The bracketed value of every `attr = …` assignment; understands `select({…})` and nested lists. */
export function attributeValues(text: string, attribute: string): string[] {
  const out: string[] = [];
  const cleaned = stripComments(text);
  const re = new RegExp(`\\b${attribute}\\s*=\\s*`, "g");
  let match: RegExpExecArray | null;
  while ((match = re.exec(cleaned))) {
    let i = re.lastIndex;
    while (i < cleaned.length && !"([{".includes(cleaned[i])) {
      if (cleaned[i] === "\n" || cleaned[i] === ";") break;
      i += 1;
    }
    if (i >= cleaned.length || !"([{".includes(cleaned[i])) continue;

    const start = i;
    const stack: string[] = [];
    let quote = "";
    for (; i < cleaned.length; i += 1) {
      const c = cleaned[i];
      if (quote) {
        if (c === "\\") i += 1;
        else if (c === quote) quote = "";
        continue;
      }
      if (c === '"' || c === "'") {
        quote = c;
        continue;
      }
      if (c === "(") stack.push(")");
      else if (c === "[") stack.push("]");
      else if (c === "{") stack.push("}");
      else if (c === ")" || c === "]" || c === "}") {
        if (stack.pop() !== c) break;
        if (!stack.length) {
          i += 1;
          break;
        }
      }
    }
    out.push(cleaned.slice(start, i));
    re.lastIndex = i;
  }
  return out;
}

function quoted(text: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) out.push(match[1]);
  return out;
}

/**
 * Resolves a Bazel label to the repository-relative package directory.
 * `//libs/shared:shared` → `libs/shared`, `:shared` → the current package, external repos → undefined.
 */
export function bazelLabelPath(label: string, fromPath: string): string | undefined {
  if (label.startsWith("@")) return undefined; // external repository – not part of this map
  if (label.startsWith(":")) return normalizePackagePath(fromPath);
  if (!label.startsWith("//")) return undefined; // file names, generated targets, expansions
  const body = label.slice(2);
  const path = body.split(":")[0].replace(/\/+$/, "");
  return path ? normalizePackagePath(path) : ".";
}

/** All dependency labels of a BUILD file. */
export function bazelDeps(text: string): string[] {
  const labels = new Set<string>();
  for (const value of attributeValues(text, "deps")) {
    for (const label of quoted(value)) {
      if (label.startsWith("//") || label.startsWith(":") || label.startsWith("@")) labels.add(label);
    }
  }
  return [...labels];
}

/** Turns parsed BUILD files into a tool graph. Kept pure so it can be tested without Bazel installed. */
export function parseBazelBuilds(builds: BuildFile[], packages: GraphPackage[]): ToolGraph | undefined {
  const nameByPath = new Map(packages.map((pkg) => [normalizePackagePath(pkg.path), pkg.name]));
  const edges = new Map<string, { from: string; to: string }>();
  const seen = new Set<string>();

  for (const build of builds) {
    const fromPath = normalizePackagePath(build.path);
    const from = nameByPath.get(fromPath);
    if (!from) continue;
    seen.add(from);
    for (const label of bazelDeps(build.text)) {
      const targetPath = bazelLabelPath(label, fromPath);
      if (!targetPath) continue;
      const to = nameByPath.get(targetPath);
      if (!to || to === from) continue;
      seen.add(to);
      edges.set(`${from}>${to}`, { from, to });
    }
  }
  if (!seen.size) return undefined;

  return {
    source: "bazel",
    packages: [...seen].sort(),
    edges: [...edges.values()].sort((a, b) => `${a.from}>${a.to}`.localeCompare(`${b.from}>${b.to}`)),
  };
}

/** Read every BUILD file and build the package graph. Returns undefined when there is none. */
export function readBazelGraph(root: string, packages: GraphPackage[]): ToolGraph | undefined {
  const builds: BuildFile[] = [];
  for (const entry of findBuildFiles(root)) {
    const file = join(entry.path, entry.file);
    try {
      builds.push({ path: normalizePackagePath(relative(root, entry.path)), text: readFileSync(file, "utf8") });
    } catch {
      // unreadable BUILD file – skip it, the manifest graph still stands
    }
  }
  return parseBazelBuilds(builds, packages);
}
