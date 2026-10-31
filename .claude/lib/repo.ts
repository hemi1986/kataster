/**
 * Deterministic repository map for monorepos and single-package repositories.
 *
 * Used by the `/adopt` scripts and (later) by the engineering hooks:
 *   - detect the build tooling (Nx, Turborepo, Bazel, pnpm/npm/yarn workspaces, Go, Cargo, Gradle, Maven)
 *   - list packages with their manifests, entry points, internal dependencies and consumers
 *   - rank adoption slices by churn, fan-in and kind
 *   - render `docs/architecture/repo-map.{json,md}`, the generated root block in `AGENTS.md`,
 *     and the per-package `AGENTS.md` / `CLAUDE.md` pair
 *
 * Rules: Node >= 22.18, erasable TypeScript only, no runtime dependency (JSON, not YAML), and no
 * project knowledge – everything comes from the repository.
 *
 * Keep the tool marker list in sync with `src/repo.mjs` (the installer uses the same detection before
 * `.claude/node_modules` exists).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { graphLabel, graphOrigin, graphToolLabel, queryToolGraph, type ToolGraph } from "./toolgraph.ts";

export const ROOT = resolve(import.meta.dirname, "..", "..");
export const REPO_MAP_JSON = join("docs", "architecture", "repo-map.json");
export const REPO_MAP_MD = join("docs", "architecture", "repo-map.md");
export const REPO_BEGIN = "<!-- kataster:repo:begin -->";
export const REPO_END = "<!-- kataster:repo:end -->";
export const PACKAGE_BEGIN = "<!-- kataster:package:begin -->";
export const PACKAGE_END = "<!-- kataster:package:end -->";

export type PackageKind = "app" | "service" | "library" | "package";

export interface Tooling {
  kind: string;
  config: string;
  workspaces: string[];
  manager: string;
  monorepo: boolean;
}

export interface RepoPackage {
  name: string;
  path: string;
  kind: PackageKind;
  language: string;
  manifest: string;
  scripts: Record<string, string>;
  entryPoints: string[];
  internalDeps: string[];
  externalDeps: number;
  consumers: string[];
  hasTests: boolean;
  adopted: boolean;
  adoptedAt?: string;
  /** Nx project name when it differs from the package name. */
  projectName?: string;
}

export interface RankedPackage {
  path: string;
  score: number;
  reasons: string[];
}

export interface RepoMap {
  version: 1;
  tooling: Tooling;
  packages: RepoPackage[];
  ranking: RankedPackage[];
  /** Optional enrichment from the build tool; the manifest graph stays the source of truth. */
  toolGraph?: ToolGraph;
}

export interface SliceProposal {
  domain?: RepoPackage;
  library?: RepoPackage;
}

type Json = Record<string, unknown>;

const IGNORED = new Set([
  "node_modules", "dist", "build", "out", "coverage", ".next", ".nuxt", ".svelte-kit", ".turbo", ".nx",
  "vendor", "target", "bin", "obj", ".git", ".claude", ".opencode", ".kataster", "__pycache__", ".venv",
  "venv", ".tox", "tmp", "temp",
]);

const MANIFESTS = [
  "package.json", "go.mod", "Cargo.toml", "pyproject.toml", "setup.py", "pom.xml",
  "build.gradle", "build.gradle.kts", "composer.json", "Gemfile",
] as const;

const MANIFEST_RANK = new Map<string, number>([
  ["package.json", 0], ["go.mod", 1], ["Cargo.toml", 2], ["pyproject.toml", 3], ["setup.py", 4],
  ["pom.xml", 5], ["build.gradle", 6], ["build.gradle.kts", 6], ["composer.json", 7], ["Gemfile", 8],
]);

const TOOL_MARKERS: { kind: string; config: string[]; require?: (text: string) => boolean }[] = [
  { kind: "bazel", config: ["MODULE.bazel", "WORKSPACE.bazel", "WORKSPACE"] },
  { kind: "nx", config: ["nx.json"] },
  { kind: "turbo", config: ["turbo.json"] },
  { kind: "rush", config: ["rush.json"] },
  { kind: "lerna", config: ["lerna.json"] },
  { kind: "pnpm", config: ["pnpm-workspace.yaml"] },
  { kind: "go-work", config: ["go.work"] },
  { kind: "cargo-workspace", config: ["Cargo.toml"], require: (text) => /^\s*\[workspace\]/m.test(text) },
  { kind: "gradle", config: ["settings.gradle.kts", "settings.gradle"], require: (text) => /\binclude\s*[(:]/.test(text) },
  { kind: "maven", config: ["pom.xml"], require: (text) => /<modules>/.test(text) },
];

const APP_DIRS = new Set(["apps", "app", "frontend", "web", "ui", "clients", "site"]);
const SERVICE_DIRS = new Set(["services", "service", "backend", "api", "server", "workers", "jobs"]);
const LIBRARY_DIRS = new Set(["libs", "lib", "packages", "shared", "common", "core", "components", "contracts"]);
const FRAMEWORK_HINTS = ["express", "fastify", "koa", "hono", "@nestjs/core", "next", "nuxt", "remix", "svelte"];

const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const isObject = (v: unknown): v is Json => v !== null && typeof v === "object" && !Array.isArray(v);

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function readJson(path: string): Json | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function toPosix(path: string): string {
  return path.split(sep).join("/");
}

export function projectPath(root: string, path: string): string {
  return toPosix(relative(resolve(root), resolve(path))) || ".";
}

function fromRoot(root: string, path: string): string {
  return path === "." ? root : join(root, path);
}

// --------------------------------------------------------------------------
// Detection
// --------------------------------------------------------------------------
export function detectTooling(root: string): Tooling {
  let tool = { kind: "none", config: "" };
  for (const candidate of TOOL_MARKERS) {
    let found = false;
    for (const name of candidate.config) {
      const path = join(root, name);
      if (!existsSync(path)) continue;
      if (candidate.require) {
        const text = readText(path);
        if (text === undefined || !candidate.require(text)) continue;
      }
      tool = { kind: candidate.kind, config: name };
      found = true;
      break;
    }
    if (found) break;
  }

  const workspaces = workspaceGlobs(root);
  const pkg = readJson(join(root, "package.json"));
  const declared = Array.isArray(pkg?.workspaces)
    || (isObject(pkg?.workspaces) && Array.isArray(pkg.workspaces.packages))
    || workspaces.length > 0;
  const kind = tool.kind !== "none" ? tool.kind : declared ? "workspaces" : "none";
  const declaredManager = typeof pkg?.packageManager === "string" ? pkg.packageManager.split("@")[0] : undefined;
  const manager = detectManager(root)
    ?? (declaredManager && ["npm", "pnpm", "yarn", "bun"].includes(declaredManager) ? declaredManager : undefined)
    ?? (tool.kind === "pnpm" || existsSync(join(root, "pnpm-workspace.yaml")) ? "pnpm" : undefined)
    ?? (pkg ? "npm" : "");

  return {
    kind,
    config: tool.config,
    workspaces,
    manager,
    monorepo: kind !== "none",
  };
}

function detectManager(root: string): string | undefined {
  if (existsSync(join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(root, "yarn.lock"))) return "yarn";
  if (existsSync(join(root, "bun.lockb")) || existsSync(join(root, "bun.lock"))) return "bun";
  if (existsSync(join(root, "package-lock.json"))) return "npm";
  return undefined;
}

export function workspaceGlobs(root: string): string[] {
  const out: string[] = [];
  const pkg = readJson(join(root, "package.json"));
  const declared = Array.isArray(pkg?.workspaces) ? pkg.workspaces : isObject(pkg?.workspaces) ? pkg.workspaces.packages : undefined;
  out.push(...list(declared));

  const pnpm = readText(join(root, "pnpm-workspace.yaml"));
  if (pnpm !== undefined) {
    let inPackages = false;
    for (const raw of pnpm.split("\n")) {
      const line = raw.replace(/#.*$/, "");
      if (/^packages\s*:/.test(line)) {
        inPackages = true;
        continue;
      }
      if (inPackages && /^\S/.test(line) && line.trim()) break;
      const match = /^\s*-\s*['"]?([^'"]+?)['"]?\s*$/.exec(line);
      if (inPackages && match) out.push(match[1]);
    }
  }

  const lerna = readJson(join(root, "lerna.json"));
  out.push(...list(lerna?.packages));

  const rush = readJson(join(root, "rush.json"));
  if (Array.isArray(rush?.projects)) {
    for (const project of rush.projects) {
      if (isObject(project) && typeof project.projectFolder === "string") out.push(project.projectFolder);
    }
  }
  return [...new Set(out)];
}

// --------------------------------------------------------------------------
// Scan
// --------------------------------------------------------------------------
interface ManifestFile {
  dir: string;
  name: string;
  path: string;
}

function findManifests(root: string): ManifestFile[] {
  const found: ManifestFile[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (IGNORED.has(entry.name) || entry.name.startsWith(".")) continue;
        walk(join(dir, entry.name));
      } else if (entry.isFile() && (MANIFESTS as readonly string[]).includes(entry.name)) {
        found.push({ dir, name: entry.name, path: join(dir, entry.name) });
      }
    }
  };
  walk(root);

  // One package per directory: the strongest manifest wins (package.json before go.mod before …).
  const byDir = new Map<string, ManifestFile>();
  for (const file of found) {
    const current = byDir.get(file.dir);
    if (!current || (MANIFEST_RANK.get(file.name) ?? 99) < (MANIFEST_RANK.get(current.name) ?? 99)) {
      byDir.set(file.dir, file);
    }
  }
  return [...byDir.values()];
}

function packageKind(path: string, scripts: Record<string, string>, deps: Record<string, string>, monorepo: boolean, entryPoints: string[] = []): PackageKind {
  const top = path.split("/")[0];
  if (APP_DIRS.has(top)) return "app";
  if (SERVICE_DIRS.has(top)) return "service";
  if (LIBRARY_DIRS.has(top)) return "library";
  if (path === ".") return monorepo ? "package" : "app";
  if (["start", "serve", "dev"].some((s) => s in scripts)) return "app";
  if (Object.keys(deps).some((d) => FRAMEWORK_HINTS.some((f) => d === f || d.startsWith(`${f}/`)))) return "service";
  // Outside the conventional apps/ services/ libs/ folders, the entry point decides: a binary is an app,
  // a library root is a library.
  if (entryPoints.some((p) => /(^|\/)(main\.(rs|go|py)|cmd)$/.test(p))) return "app";
  if (entryPoints.some((p) => /(^|\/)(lib\.rs|__init__\.py)$/.test(p))) return "library";
  return "package";
}

function languageOf(dir: string, manifest: string): string {
  if (manifest === "package.json") {
    if (existsSync(join(dir, "tsconfig.json")) || hasExtension(dir, [".ts", ".tsx"])) return "TypeScript";
    return "JavaScript";
  }
  if (manifest === "go.mod") return "Go";
  if (manifest === "Cargo.toml") return "Rust";
  if (manifest === "pyproject.toml" || manifest === "setup.py") return "Python";
  if (manifest === "pom.xml") return "Java";
  if (manifest === "build.gradle" || manifest === "build.gradle.kts") {
    return hasExtension(dir, [".kt", ".kts"]) ? "Kotlin" : "Java";
  }
  if (manifest === "composer.json") return "PHP";
  if (manifest === "Gemfile") return "Ruby";
  return "unknown";
}

/** Cheap check for a file extension in the package's own tree (bounded, ignores build dirs). */
function hasExtension(dir: string, extensions: string[], limit = 200): boolean {
  let seen = 0;
  const walk = (current: string): boolean => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      if (seen >= limit) return false;
      if (entry.isDirectory()) {
        if (IGNORED.has(entry.name) || entry.name.startsWith(".")) continue;
        if (walk(join(current, entry.name))) return true;
      } else if (entry.isFile()) {
        seen += 1;
        if (extensions.some((ext) => entry.name.endsWith(ext))) return true;
      }
    }
    return false;
  };
  return walk(dir);
}

function entryPointsOf(dir: string, manifest: string, pkg: Json | undefined): string[] {
  const out: string[] = [];
  const add = (value: unknown): void => {
    if (typeof value === "string" && value && !value.startsWith("/") && !value.includes("://") && !value.startsWith("node:")) {
      out.push(value.replace(/^\.\//, ""));
    }
  };
  if (manifest === "package.json" && pkg) {
    for (const key of ["main", "module", "types", "bin"]) {
      const value = pkg[key];
      if (isObject(value)) Object.values(value).forEach(add);
      else add(value);
    }
    if (isObject(pkg.exports)) {
      for (const value of Object.values(pkg.exports)) {
        if (isObject(value)) Object.values(value).forEach(add);
        else add(value);
      }
    }
    for (const candidate of ["src/index.ts", "src/index.tsx", "src/index.js", "src/main.ts", "src/server.ts", "src/app.ts", "index.ts", "index.js", "src/index.py", "src/main.py"]) {
      if (existsSync(join(dir, candidate))) out.push(candidate);
    }
  } else if (manifest === "go.mod") {
    for (const candidate of ["main.go", "cmd"]) if (existsSync(join(dir, candidate))) out.push(candidate);
  } else if (manifest === "Cargo.toml") {
    for (const candidate of ["src/main.rs", "src/lib.rs"]) if (existsSync(join(dir, candidate))) out.push(candidate);
  } else if (manifest === "pyproject.toml" || manifest === "setup.py") {
    for (const candidate of ["src", "main.py", "__init__.py"]) if (existsSync(join(dir, candidate))) out.push(candidate);
  }
  return [...new Set(out)].slice(0, 6);
}

interface ParsedManifest {
  name: string;
  scripts: Record<string, string>;
  deps: Record<string, string>;
  externalDeps: number;
}

function parseManifest(file: ManifestFile): ParsedManifest {
  const text = readText(file.path) ?? "";
  if (file.name === "package.json") {
    const pkg = readJson(file.path);
    const scripts: Record<string, string> = {};
    for (const [key, value] of Object.entries(isObject(pkg?.scripts) ? pkg.scripts : {})) {
      if (typeof value === "string") scripts[key] = value;
    }
    const deps: Record<string, string> = {};
    for (const key of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      const block = pkg?.[key];
      if (!isObject(block)) continue;
      for (const [name, version] of Object.entries(block)) {
        if (typeof version === "string") deps[name] = version;
      }
    }
    return {
      name: typeof pkg?.name === "string" ? pkg.name : basename(file.dir),
      scripts,
      deps,
      externalDeps: Object.keys(deps).length,
    };
  }

  if (file.name === "go.mod") {
    const module = /^module\s+(\S+)/m.exec(text)?.[1] ?? basename(file.dir);
    const deps: Record<string, string> = {};
    for (const match of text.matchAll(/^\s*(?:require\s+)?([\w./-]+)\s+v[\w.-]+/gm)) deps[match[1]] = "*";
    return { name: module, scripts: {}, deps, externalDeps: Object.keys(deps).length };
  }

  if (file.name === "Cargo.toml") {
    const name = /^\s*name\s*=\s*"([^"]+)"/m.exec(text)?.[1] ?? basename(file.dir);
    const deps: Record<string, string> = {};
    // Only dependency sections; `name = "…"` in [package] is not a dependency.
    let section = "";
    for (const line of text.split("\n")) {
      const header = /^\s*\[([^\]]+)\]\s*$/.exec(line);
      if (header) {
        section = header[1];
        continue;
      }
      if (!/^(?:workspace\.)?(?:dev-|build-)?dependencies$/.test(section)) continue;
      const match = /^\s*([A-Za-z0-9_-]+)\s*=\s*(?:\{[^}]*\}|"[^"]+")/.exec(line);
      if (match) deps[match[1]] = "*";
    }
    return { name, scripts: {}, deps, externalDeps: Object.keys(deps).length };
  }

  if (file.name === "pyproject.toml") {
    const name = /^\s*name\s*=\s*"([^"]+)"/m.exec(text)?.[1] ?? basename(file.dir);
    const deps: Record<string, string> = {};
    const block = /^\s*dependencies\s*=\s*\[([\s\S]*?)\]/m.exec(text)?.[1] ?? "";
    for (const match of block.matchAll(/"([^"]+)"/g)) {
      const dep = match[1].split(/[<>=!~@;\[ ]/)[0].trim();
      if (dep) deps[dep] = "*";
    }
    return { name, scripts: {}, deps, externalDeps: Object.keys(deps).length };
  }

  if (file.name === "setup.py") {
    return { name: basename(file.dir), scripts: {}, deps: {}, externalDeps: 0 };
  }

  if (file.name === "pom.xml") {
    const name = /<artifactId>([^<]+)<\/artifactId>/.exec(text)?.[1] ?? basename(file.dir);
    return { name, scripts: {}, deps: {}, externalDeps: 0 };
  }

  if (file.name === "build.gradle" || file.name === "build.gradle.kts") {
    const name = /rootProject\.name\s*=\s*["']([^"']+)["']/.exec(text)?.[1] ?? basename(file.dir);
    return { name, scripts: {}, deps: {}, externalDeps: 0 };
  }

  if (file.name === "composer.json") {
    const pkg = readJson(file.path);
    const deps: Record<string, string> = {};
    for (const key of ["require", "require-dev"]) {
      const block = pkg?.[key];
      if (!isObject(block)) continue;
      for (const [dep, version] of Object.entries(block)) if (typeof version === "string") deps[dep] = version;
    }
    return { name: typeof pkg?.name === "string" ? pkg.name : basename(file.dir), scripts: {}, deps, externalDeps: Object.keys(deps).length };
  }

  return { name: basename(file.dir), scripts: {}, deps: {}, externalDeps: 0 };
}

function hasTests(dir: string, scripts: Record<string, string>): boolean {
  if (typeof scripts.test === "string" && scripts.test.trim()) return true;
  return ["test", "tests", "__tests__", "e2e", "spec"].some((name) => existsSync(join(dir, name)));
}

function languageForDir(dir: string): string {
  if (existsSync(join(dir, "tsconfig.json")) || hasExtension(dir, [".ts", ".tsx"])) return "TypeScript";
  if (hasExtension(dir, [".js", ".jsx", ".mjs", ".cjs"])) return "JavaScript";
  if (hasExtension(dir, [".go"])) return "Go";
  if (hasExtension(dir, [".rs"])) return "Rust";
  if (hasExtension(dir, [".py"])) return "Python";
  if (hasExtension(dir, [".kt", ".kts"])) return "Kotlin";
  if (hasExtension(dir, [".java"])) return "Java";
  return "unknown";
}

/** Bazel packages are directories with a BUILD file, not directories with a manifest. */
function findBuildDirs(root: string, limit = 500): { dir: string; file: string }[] {
  const out: { dir: string; file: string }[] = [];
  const walk = (dir: string): void => {
    if (out.length >= limit) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (IGNORED.has(entry.name) || entry.name.startsWith(".")) continue;
        walk(join(dir, entry.name));
      } else if (entry.isFile() && (entry.name === "BUILD" || entry.name === "BUILD.bazel")) {
        out.push({ dir, file: entry.name });
      }
    }
  };
  walk(root);
  return out;
}

function readNxProjectName(dir: string): string | undefined {
  for (const file of ["project.json", "project.jsonc"]) {
    const data = readJson(join(dir, file));
    if (typeof data?.name === "string") return data.name;
  }
  return undefined;
}

function resolveWorkspaceDep(name: string, version: string, packages: RepoPackage[]): string | undefined {
  const byName = packages.find((p) => p.name === name);
  if (byName) return byName.name;
  if (version.startsWith("file:") || version.startsWith("link:") || version.startsWith("workspace:")) {
    const target = version.replace(/^(file|link|workspace):/, "").replace(/^\.\//, "");
    if (!target || target === "*") return undefined;
    const wanted = toPosix(target).replace(/\/$/, "");
    const byPath = packages.find((p) => p.path === wanted || p.path.endsWith(`/${wanted}`));
    return byPath?.name;
  }
  return undefined;
}

export function scanRepo(root: string, options: { toolGraph?: boolean } = {}): RepoMap {
  const tooling = detectTooling(root);
  const manifests = findManifests(root);

  const packages: RepoPackage[] = [];
  for (const file of manifests) {
    const path = projectPath(root, file.dir);
    if (tooling.monorepo && path === ".") continue; // the workspace root is not a package
    const parsed = parseManifest(file);
    const entryPoints = entryPointsOf(file.dir, file.name, readJson(file.path));
    const kind = packageKind(path, parsed.scripts, parsed.deps, tooling.monorepo, entryPoints);
    packages.push({
      name: parsed.name,
      path,
      kind,
      language: languageOf(file.dir, file.name),
      manifest: projectPath(root, file.path),
      scripts: parsed.scripts,
      entryPoints,
      internalDeps: [],
      externalDeps: parsed.externalDeps,
      consumers: [],
      hasTests: hasTests(file.dir, parsed.scripts),
      adopted: false,
      projectName: readNxProjectName(file.dir),
    });
  }

  // Bazel's unit is the directory with a BUILD file. Add those that do not already have a manifest package,
  // so a Bazel repository can be sliced even when it has no package.json.
  if (tooling.kind === "bazel") {
    const seen = new Set(packages.map((p) => p.path));
    for (const build of findBuildDirs(root)) {
      const path = projectPath(root, build.dir);
      if (path === "." || seen.has(path)) continue;
      seen.add(path);
      packages.push({
        name: path.split("/").pop() ?? path,
        path,
        kind: packageKind(path, {}, {}, true),
        language: languageForDir(build.dir),
        manifest: projectPath(root, join(build.dir, build.file)),
        scripts: {},
        entryPoints: [],
        internalDeps: [],
        externalDeps: 0,
        consumers: [],
        hasTests: false,
        adopted: false,
      });
    }
  }

  // A repository without manifests is still a repository: fall back to the code roots from the profile.
  if (!packages.length) {
    const profile = readProfile(root);
    const roots = list(profile?.repo && isObject(profile.repo) ? profile.repo.codeRoots : []);
    const language = list(profile?.stack && isObject(profile.stack) ? profile.stack.languages : [])[0] ?? "unknown";
    for (const path of roots.length ? roots : ["."]) {
      packages.push({
        name: typeof profile?.name === "string" ? profile.name : basename(root),
        path: path === "." ? "." : toPosix(path),
        kind: "app",
        language,
        manifest: "",
        scripts: {},
        entryPoints: [],
        internalDeps: [],
        externalDeps: 0,
        consumers: [],
        hasTests: false,
        adopted: false,
      });
    }
  }

  // Resolve internal edges by name or workspace path.
  for (const file of manifests) {
    const path = projectPath(root, file.dir);
    const pkg = packages.find((p) => p.path === path);
    if (!pkg) continue;
    const parsed = parseManifest(file);
    const internal: string[] = [];
    for (const [name, version] of Object.entries(parsed.deps)) {
      const target = resolveWorkspaceDep(name, version, packages);
      if (target && target !== pkg.name) internal.push(target);
    }
    pkg.internalDeps = [...new Set(internal)];
    pkg.externalDeps = Math.max(0, parsed.externalDeps - pkg.internalDeps.length);
  }

  const byName = new Map(packages.map((p) => [p.name, p]));
  for (const pkg of packages) {
    for (const dep of pkg.internalDeps) {
      const target = byName.get(dep);
      if (target && !target.consumers.includes(pkg.name)) target.consumers.push(pkg.name);
    }
  }
  for (const pkg of packages) pkg.consumers.sort();
  packages.sort((a, b) => a.path.localeCompare(b.path));

  const ranking = rankPackages(root, packages);
  const map: RepoMap = { version: 1, tooling, packages, ranking };
  // Enrichment only. The manifest graph remains the source of truth, so the map stays usable without the
  // build tool: Turbo exposes a task graph, Nx a project graph, Bazel its BUILD deps.
  if (options.toolGraph !== false && tooling.kind !== "none") {
    const graph = queryToolGraph(root, tooling.kind, packages);
    if (graph) map.toolGraph = graph;
  }
  return map;
}

export function readProfile(root: string): Json | undefined {
  return readJson(join(root, ".claude", "project.json"));
}

function recentFiles(root: string, limit = 500): string[] {
  try {
    const out = execFileSync("git", ["log", "--format=", "--name-only", "-n", String(limit)], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 15_000,
    });
    return out.split("\n").map((line) => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

export function rankPackages(root: string, packages: RepoPackage[]): RankedPackage[] {
  const files = recentFiles(root);
  const churn = new Map<string, number>();
  for (const pkg of packages) {
    const prefix = pkg.path === "." ? "" : `${pkg.path}/`;
    churn.set(pkg.name, files.filter((file) => (pkg.path === "." ? true : file.startsWith(prefix))).length);
  }
  const maxChurn = Math.max(1, ...churn.values());
  const maxConsumers = Math.max(1, ...packages.map((p) => p.consumers.length));

  return packages
    .map((pkg) => {
      const changes = churn.get(pkg.name) ?? 0;
      const score = 0.55 * (changes / maxChurn) + 0.3 * (pkg.consumers.length / maxConsumers) + 0.15 * (pkg.kind === "library" ? 0.4 : 1);
      const reasons: string[] = [];
      if (changes) reasons.push(`${changes} changed file${changes === 1 ? "" : "s"} in recent history`);
      if (pkg.consumers.length) {
        const n = pkg.consumers.length;
        reasons.push(`${n} package${n === 1 ? "" : "s"} ${n === 1 ? "depends" : "depend"} on it`);
      }
      if (pkg.kind !== "package") reasons.push(pkg.kind === "library" ? "shared library" : pkg.kind);
      if (!reasons.length) reasons.push("no churn or consumers recorded");
      return { path: pkg.path, score: Math.round(score * 100) / 100, reasons };
    })
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
}

export function proposeSlices(map: RepoMap): SliceProposal {
  const byPath = new Map(map.packages.map((p) => [p.path, p]));
  const ranked = map.ranking.map((r) => byPath.get(r.path)).filter((p): p is RepoPackage => p !== undefined);
  const domain = ranked.find((p) => p.kind === "app" || p.kind === "service") ?? ranked.find((p) => p.kind !== "library") ?? ranked[0];
  if (!domain) return {};

  const libs = domain.internalDeps
    .map((name) => map.packages.find((p) => p.name === name))
    .filter((p): p is RepoPackage => p !== undefined && p.kind === "library")
    .sort((a, b) => b.consumers.length - a.consumers.length);
  const library = libs[0] ?? ranked.find((p) => p.kind === "library" && p.name !== domain.name);
  return { domain, library };
}

// --------------------------------------------------------------------------
// Commands
// --------------------------------------------------------------------------
export function taskCommand(tooling: Tooling, pkg: RepoPackage, task: string): string {
  // Nx project names are usually the package name without the scope; project.json wins when it exists.
  const project = pkg.projectName ?? pkg.name.replace(/^@[^/]+\//, "");
  const path = pkg.path;
  switch (tooling.kind) {
    case "nx":
      return `nx run ${project}:${task}`;
    case "turbo":
      return `turbo run ${task} --filter=${pkg.name}`;
    case "bazel":
      return task === "test" ? `bazel test //${path}/...` : task === "build" ? `bazel build //${path}/...` : "";
    case "pnpm":
      return `pnpm --filter ${pkg.name} ${task}`;
    case "workspaces":
      if (tooling.manager === "yarn") return `yarn workspace ${pkg.name} ${task}`;
      if (tooling.manager === "bun") return `bun run --filter ${pkg.name} ${task}`;
      return `npm run ${task} --workspace ${pkg.name}`;
    case "go-work":
      return task === "test" ? `go test ./${path}/...` : task === "build" ? `go build ./${path}/...` : task === "lint" ? `go vet ./${path}/...` : "";
    case "cargo-workspace":
      return task === "lint" ? `cargo clippy -p ${pkg.name} -- -D warnings` : `cargo ${task} -p ${pkg.name}`;
    case "gradle":
      return `./gradlew :${path.split("/").join(":")}:${task}`;
    case "maven":
      return `mvn -pl ${path} ${task}`;
    default:
      if (pkg.scripts[task]) return path === "." ? `npm run ${task}` : `npm --prefix ${path} run ${task}`;
      return "";
  }
}

export function templateCommand(tooling: Tooling, task: string): string {
  switch (tooling.kind) {
    case "nx": return `nx run <project>:${task}`;
    case "turbo": return `turbo run ${task} --filter=<package>`;
    case "bazel": return task === "test" ? "bazel test //<package>/..." : task === "build" ? "bazel build //<package>/..." : "";
    case "pnpm": return `pnpm --filter <package> ${task}`;
    case "workspaces":
      if (tooling.manager === "yarn") return `yarn workspace <package> ${task}`;
      if (tooling.manager === "bun") return `bun run --filter <package> ${task}`;
      return `npm run ${task} --workspace <package>`;
    case "go-work": return task === "test" ? "go test ./<package>/..." : task === "build" ? "go build ./<package>/..." : task === "lint" ? "go vet ./<package>/..." : "";
    case "cargo-workspace": return task === "lint" ? `cargo clippy -p <package> -- -D warnings` : `cargo ${task} -p <package>`;
    case "gradle": return `./gradlew :<package>:${task}`;
    case "maven": return `mvn -pl <package> ${task}`;
    default: return "";
  }
}

export function affectedCommand(tooling: Tooling): string {
  switch (tooling.kind) {
    case "nx": return "nx affected -t test";
    case "turbo": return "turbo run test --filter='...[HEAD^1]'";
    case "pnpm": return "pnpm -r --filter '...[HEAD^1]' test";
    default: return "";
  }
}

// --------------------------------------------------------------------------
// Rendering
// --------------------------------------------------------------------------
function installCommand(tooling: Tooling, configured = ""): string {
  if (configured) return configured;
  switch (tooling.kind) {
    case "go-work": return "go mod download";
    case "cargo-workspace": return "cargo build";
    case "gradle": return "./gradlew build";
    case "maven": return "mvn install";
    case "bazel": return "bazel build //...";
    default: return tooling.manager ? `${tooling.manager} install` : "";
  }
}

function toolingLabel(tooling: Tooling): string {
  if (tooling.kind === "none") return "none (single package)";
  const names: Record<string, string> = {
    bazel: "Bazel", nx: "Nx", turbo: "Turborepo", rush: "Rush", lerna: "Lerna", pnpm: "pnpm workspaces",
    "go-work": "Go workspace", "cargo-workspace": "Cargo workspace", gradle: "Gradle", maven: "Maven",
    workspaces: `${tooling.manager || "npm"} workspaces`,
  };
  return `${names[tooling.kind] ?? tooling.kind}${tooling.config ? ` (\`${tooling.config}\`)` : ""}`;
}

export function packageCounts(map: RepoMap): string {
  const apps = map.packages.filter((p) => p.kind === "app" || p.kind === "service").length;
  const libs = map.packages.filter((p) => p.kind === "library").length;
  return `${apps} ${apps === 1 ? "app/service" : "apps/services"}, ${libs} ${libs === 1 ? "library" : "libraries"}`;
}

function groups(packages: RepoPackage[]): { dir: string; total: number; kinds: PackageKind[] }[] {
  const byDir = new Map<string, RepoPackage[]>();
  for (const pkg of packages) {
    const dir = pkg.path === "." ? "." : pkg.path.split("/")[0];
    byDir.set(dir, [...(byDir.get(dir) ?? []), pkg]);
  }
  return [...byDir.entries()]
    .map(([dir, list]) => ({ dir, total: list.length, kinds: [...new Set(list.map((p) => p.kind))] }))
    .sort((a, b) => b.total - a.total || a.dir.localeCompare(b.dir));
}

function tableCell(value: string): string {
  return value.replaceAll("|", "\\|") || "–";
}

export function renderRepoMapMarkdown(map: RepoMap): string {
  const out: string[] = [
    "# Repository map",
    "",
    "> Generated from the repository's manifests by `repo-map.ts` – **do not edit manually**. Refresh with",
    "> `node .claude/skills/adopt/scripts/repo-map.ts`.",
    "",
    `- **Tooling:** ${toolingLabel(map.tooling)}`,
    `- **Workspaces:** ${map.tooling.workspaces.length ? map.tooling.workspaces.map((w) => `\`${w}\``).join(", ") : "–"}`,
    `- **Packages:** ${map.packages.length} (${packageCounts(map)})`,
    `- **Adopted:** ${map.packages.filter((p) => p.adopted).length} of ${map.packages.length}`,
    ...(map.toolGraph
      ? [`- **Tool graph:** ${graphLabel(map.toolGraph)}${map.toolGraph.task ? ` (\`${map.toolGraph.task}\`)` : ""} – ${map.toolGraph.packages.length} package(s), ${map.toolGraph.edges.length} edge(s); used for affected runs`]
      : [`- **Tool graph:** manifests only${graphToolLabel(map.tooling.kind) ? ` (no ${graphToolLabel(map.tooling.kind)} graph found)` : ""}`]),
    "",
    "## Packages",
    "",
    "| Package | Path | Kind | Language | Depends on | Used by | Adopted |",
    "|---|---|---|---|---|---|---|",
  ];

  for (const pkg of [...map.packages].sort((a, b) => a.path.localeCompare(b.path))) {
    out.push(
      `| ${tableCell(pkg.name)} | \`${pkg.path}\` | ${pkg.kind} | ${pkg.language} | ` +
        `${pkg.internalDeps.length ? pkg.internalDeps.map((d) => `\`${d}\``).join(", ") : "–"} | ` +
        `${pkg.consumers.length ? pkg.consumers.map((d) => `\`${d}\``).join(", ") : "–"} | ` +
        `${pkg.adopted ? "yes" : "–"} |`,
    );
  }
  out.push("");

  const edges = map.packages.flatMap((pkg) => pkg.internalDeps.map((dep) => [pkg, dep] as const));
  if (edges.length) {
    const nodes = new Map<string, RepoPackage>();
    for (const [pkg, dep] of edges.slice(0, 80)) {
      nodes.set(pkg.name, pkg);
      const target = map.packages.find((p) => p.name === dep);
      if (target) nodes.set(target.name, target);
    }
    const id = (name: string): string => name.replace(/[^A-Za-z0-9_]/g, "_");
    out.push("## Dependency edges", "", "```mermaid", "flowchart LR");
    for (const pkg of [...nodes.values()].slice(0, 60)) {
      out.push(`    ${id(pkg.name)}["${pkg.name.replaceAll('"', "'")}"]`);
    }
    for (const [pkg, dep] of edges.slice(0, 80)) {
      if (nodes.has(pkg.name) && nodes.has(dep)) out.push(`    ${id(pkg.name)} --> ${id(dep)}`);
    }
    out.push("```", "");
    if (edges.length > 80) out.push(`_Graph truncated at 80 edges (${edges.length} total). See the table above._`, "");
  }

  if (map.toolGraph) {
    out.push(
      `## Tool graph (${graphLabel(map.toolGraph)})`,
      "",
      `Source: \`${graphOrigin(map.toolGraph)}\`. The manifest graph above stays the source of truth;`,
      "this graph is cross-checked and used for affected test runs.",
      "",
      "| From | To |",
      "|---|---|",
    );
    for (const edge of map.toolGraph.edges.slice(0, 80)) out.push(`| \`${edge.from}\` | \`${edge.to}\` |`);
    if (map.toolGraph.edges.length > 80) out.push(`| … | ${map.toolGraph.edges.length - 80} more |`);
    out.push("");
  }

  out.push("## Commands", "", "| Scope | Command |", "|---|---|");
  const install = installCommand(map.tooling);
  if (install) out.push(`| Install | \`${install}\` |`);
  const one = templateCommand(map.tooling, "test");
  if (one) out.push(`| One package | \`${one}\` |`);
  const affected = affectedCommand(map.tooling);
  if (affected) out.push(`| Affected only | \`${affected}\` |`);
  out.push("");

  out.push("## Adoption ranking", "", "| # | Package | Score | Why |", "|---|---|---|---|");
  const byPath = new Map(map.packages.map((p) => [p.path, p]));
  map.ranking.forEach((rank, index) => {
    out.push(`| ${index + 1} | \`${rank.path}\` (${tableCell(byPath.get(rank.path)?.name ?? "")}) | ${rank.score.toFixed(2)} | ${rank.reasons.join("; ")} |`);
  });
  out.push("");

  const { domain, library } = proposeSlices(map);
  if (domain) {
    const label = domain.path === "." ? "root package" : `\`${domain.path}\``;
    out.push("## Suggested first slice", "", `- **Domain:** ${label} (${domain.name})`);
    if (library) out.push(`- **Shared library:** \`${library.path}\` (${library.name})`);
    out.push("", "Adopt one domain and at most one shared library per session. Then mark the slice adopted:", "", "```bash", `node .claude/skills/adopt/scripts/repo-map.ts --adopt ${domain.path}`, "```", "");
  }
  return out.join("\n");
}

export function rootBlock(map: RepoMap, root = resolve(import.meta.dirname, "..", "..")): string {
  const profile = readProfile(root);
  const commands = isObject(profile?.commands) ? profile.commands : {};
  const command = (key: string): string => (typeof commands[key] === "string" ? commands[key] : "");
  const groupsList = groups(map.packages);
  const adopted = map.packages.filter((p) => p.adopted);

  const lines = [
    REPO_BEGIN,
    "<!-- Generated from docs/architecture/repo-map.json by repo-map.ts. Do not edit inside this block. -->",
    "## Repository map",
    "",
    `- **Tooling:** ${toolingLabel(map.tooling)} · **Packages:** ${map.packages.length} · **Adopted:** ${adopted.length} of ${map.packages.length}`,
  ];
  if (map.toolGraph) {
    lines.push(
      `- **Tool graph:** ${graphLabel(map.toolGraph)}${map.toolGraph.task ? ` (\`${map.toolGraph.task}\`)` : ""} – used for affected test runs.`,
    );
  }
  if (groupsList.length) {
    lines.push(`- **Layout:** ${groupsList.slice(0, 8).map((g) => `\`${g.dir}/\` (${g.total})`).join(", ")}`);
  }
  lines.push("- **Detail:** `docs/architecture/repo-map.md` – package list, dependency edges, consumers, adoption ranking.");
  if (adopted.length) {
    const rest = map.packages.length - adopted.length;
    const labels = adopted.map((p) => (p.path === "." ? "root package" : `\`${p.path}\``));
    lines.push(
      `- **Adopted slices:** ${labels.join(", ")}` +
        (rest ? `. Everything else is **not adopted**: run \`/adopt <path>\` before inferring domain there.` : "."),
    );
  } else {
    lines.push("- **No package is adopted yet.** Run `/adopt` before inferring domain from code.");
  }
  lines.push("", "## Commands", "", "| Scope | Command |", "|---|---|");

  const rows: [string, string][] = [
    ["Install", installCommand(map.tooling, command("install"))],
    ["Lint", command("lint")],
    ["Typecheck", command("typecheck")],
    ["Test", command("test")],
    ["End-to-end", command("e2e")],
    ["One package", templateCommand(map.tooling, "test")],
    ["Affected only", affectedCommand(map.tooling)],
    ["Gate", "node .claude/skills/implement/scripts/verify.ts"],
  ];
  for (const [scope, value] of rows) {
    if (value) lines.push(`| ${scope} | \`${value}\` |`);
  }
  lines.push(
    "",
    "## Read next",
    "",
    "- `docs/architecture/repo-map.md` – where domains and shared libraries live",
    "- `docs/engineering/conventions.md` – how code is built in this repository",
    "- `CONTEXT.md` – domain language; this file stays free of domain rules on purpose",
    "- Package docs: `<package>/AGENTS.md` (loaded when you work there) with `<package>/CLAUDE.md` as the Claude Code entry",
    REPO_END,
  );
  return lines.join("\n");
}

export function upsertBlock(existing: string, block: string, begin: string, end: string): string {
  const start = existing.indexOf(begin);
  const stop = existing.indexOf(end);
  if (start !== -1 && stop !== -1 && stop > start) {
    return `${existing.slice(0, start)}${block}${existing.slice(stop + end.length)}`.replace(/\n{3,}/g, "\n\n");
  }
  const trimmed = existing.trimEnd();
  return `${trimmed}${trimmed ? "\n\n" : ""}${block}\n`;
}

// --------------------------------------------------------------------------
// Package documents
// --------------------------------------------------------------------------
function taskAvailable(map: RepoMap, pkg: RepoPackage, task: string): boolean {
  if (pkg.scripts[task]) return true;
  if (task === "test" && pkg.hasTests) return true;
  if (map.tooling.kind === "go-work") return task === "test" || task === "build" || task === "lint";
  if (map.tooling.kind === "cargo-workspace") return task === "test" || task === "build" || task === "lint";
  if (map.tooling.kind === "gradle" || map.tooling.kind === "maven") return task === "test" || task === "build";
  if (map.tooling.kind === "bazel") return task === "test" || task === "build";
  return false;
}

function commandLines(map: RepoMap, pkg: RepoPackage): string[] {
  const entries: [string, string][] = [];
  for (const task of ["build", "lint", "typecheck", "test", "e2e"]) {
    if (!taskAvailable(map, pkg, task)) continue;
    const value = taskCommand(map.tooling, pkg, task);
    if (value) entries.push([task, value]);
  }
  return entries.map(([task, value]) => `- **${task.charAt(0).toUpperCase()}${task.slice(1)}:** \`${value}\``);
}

export function packageBlock(map: RepoMap, pkg: RepoPackage): string {
  const lines = [
    PACKAGE_BEGIN,
    "<!-- Generated from docs/architecture/repo-map.json by package-doc.ts. Do not edit inside this block. -->",
    "## Facts",
    "",
    `- **Path:** \`${pkg.path}\``,
    `- **Kind:** ${pkg.kind} · ${pkg.language}`,
  ];
  if (pkg.manifest) lines.push(`- **Manifest:** \`${pkg.manifest}\``);
  lines.push(...commandLines(map, pkg));
  lines.push(`- **Depends on:** ${pkg.internalDeps.length ? pkg.internalDeps.map((d) => `\`${d}\``).join(", ") : "– no internal packages"}`);
  lines.push(`- **Used by:** ${pkg.consumers.length ? pkg.consumers.map((d) => `\`${d}\``).join(", ") : "– no internal consumers"}`);
  if (pkg.entryPoints.length) lines.push(`- **Entry points:** ${pkg.entryPoints.map((p) => `\`${p}\``).join(", ")}`);
  lines.push(PACKAGE_END);
  return lines.join("\n");
}

function proseSkeleton(pkg: RepoPackage): string {
  if (pkg.kind === "library") {
    return [
      "## Purpose",
      "",
      "[OPEN] Why does this package exist? One or two sentences, in the domain's words.",
      "",
      "## Public API",
      "",
      "[OPEN] What is exported and stable, and what is deliberately internal?",
      "",
      "## Consumers",
      "",
      "[OPEN] Who depends on it, and what may they rely on? The generated list above is only the current state.",
      "",
      "## Compatibility rules",
      "",
      "[OPEN] What must not break without a migration? Versioning, deprecation, data formats.",
      "",
      "## Typical pitfalls",
      "",
      "[OPEN] What breaks here? From tests, incidents and git history – not guesses.",
      "",
      "## Boundaries",
      "",
      "- May import: [OPEN]",
      "- Must not import: [OPEN] (shared libraries never import apps or services)",
      "- Cross-context communication: only through published contracts or events.",
      "",
      "## Read next",
      "",
      "- `docs/architecture/repo-map.md`",
      "- `CONTEXT.md`",
      "- `docs/domain/events.yaml`",
      "",
    ].join("\n");
  }

  return [
    "## Purpose",
    "",
    "[OPEN] Why does this package exist? One or two sentences, in the domain's words.",
    "",
    "## Key entities",
    "",
    "[OPEN] The terms from `CONTEXT.md` this package owns or changes; aggregate IDs from `docs/domain/events.yaml`.",
    "",
    "## External interfaces",
    "",
    "[OPEN] HTTP/CLI/events/exports: what can the outside call, and what is deliberately private?",
    "",
    "## Typical pitfalls",
    "",
    "[OPEN] What breaks here? From tests, incidents and git history – not guesses.",
    "",
    "## Boundaries",
    "",
    "- May import: [OPEN]",
    "- Must not import: [OPEN]",
    "- Cross-context communication: only through published contracts or events.",
    "",
    "## Read next",
    "",
    "- `docs/architecture/repo-map.md`",
    "- `CONTEXT.md`",
    "- `docs/domain/events.yaml`",
    "",
  ].join("\n");
}

export function renderPackageDoc(map: RepoMap, pkg: RepoPackage): string {
  return [
    `# ${pkg.name}`,
    "",
    `> Read this when you work in \`${pkg.path}\`. Repository-wide rules: root \`AGENTS.md\`.`,
    "",
    packageBlock(map, pkg),
    "",
    proseSkeleton(pkg),
  ].join("\n");
}

/** Replaces only the generated block; existing prose stays untouched. Returns null when the file has no markers. */
export function updatePackageDoc(existing: string, map: RepoMap, pkg: RepoPackage): string | null {
  if (!existing.includes(PACKAGE_BEGIN) || !existing.includes(PACKAGE_END)) return null;
  return upsertBlock(existing, packageBlock(map, pkg), PACKAGE_BEGIN, PACKAGE_END);
}

export function claudeTwin(pkg: RepoPackage): string {
  return `# ${pkg.name}\n\n@AGENTS.md\n`;
}

// --------------------------------------------------------------------------
// Persistence
// --------------------------------------------------------------------------
export function writeRepoMap(root: string, map: RepoMap): { json: string; md: string } {
  const jsonPath = join(root, REPO_MAP_JSON);
  const mdPath = join(root, REPO_MAP_MD);
  mkdirSync(dirname(jsonPath), { recursive: true });
  writeFileSync(jsonPath, `${JSON.stringify(map, null, 2)}\n`, "utf8");
  writeFileSync(mdPath, renderRepoMapMarkdown(map), "utf8");
  return { json: jsonPath, md: mdPath };
}

export function readRepoMap(root: string): RepoMap | undefined {
  const value = readJson(join(root, REPO_MAP_JSON));
  if (!value || value.version !== 1 || !Array.isArray(value.packages)) return undefined;
  return value as unknown as RepoMap;
}

export function updateProjectTooling(root: string, tooling: Tooling): boolean {
  const path = join(root, ".claude", "project.json");
  const profile = readJson(path);
  if (!profile) return false;
  const repo = isObject(profile.repo) ? profile.repo : {};
  const before = JSON.stringify(repo.tooling);
  repo.tooling = tooling;
  profile.repo = repo;
  const after = JSON.stringify(repo.tooling);
  if (before === after) return false;
  writeFileSync(path, `${JSON.stringify(profile, null, 2)}\n`, "utf8");
  return true;
}

export function writeRootBlock(root: string, map: RepoMap): boolean {
  const path = join(root, "AGENTS.md");
  const existing = readText(path) ?? "";
  const next = upsertBlock(existing, rootBlock(map, root), REPO_BEGIN, REPO_END);
  if (next === existing) return false;
  writeFileSync(path, next, "utf8");
  return true;
}

export interface PackageDocResult {
  agents: string;
  claude: string;
  status: "created" | "refreshed" | "kept";
}

export function writePackageDoc(root: string, map: RepoMap, pkg: RepoPackage): PackageDocResult {
  if (pkg.path === ".") throw new Error("the root package is documented in AGENTS.md, not in a package file");
  const dir = fromRoot(root, pkg.path);
  mkdirSync(dir, { recursive: true });
  const agentsPath = join(dir, "AGENTS.md");
  const claudePath = join(dir, "CLAUDE.md");
  const existing = readText(agentsPath);
  let content: string;
  let status: PackageDocResult["status"];

  if (existing === undefined) {
    content = renderPackageDoc(map, pkg);
    status = "created";
  } else {
    const updated = updatePackageDoc(existing, map, pkg);
    if (updated === null) {
      // Hand-written docs stay untouched, but Claude Code still needs the one-line entry file.
      if (!existsSync(claudePath)) writeFileSync(claudePath, claudeTwin(pkg), "utf8");
      return { agents: agentsPath, claude: claudePath, status: "kept" };
    }
    content = updated;
    status = "refreshed";
  }
  if (content !== existing) writeFileSync(agentsPath, content, "utf8");
  if (!existsSync(claudePath)) writeFileSync(claudePath, claudeTwin(pkg), "utf8");
  return { agents: agentsPath, claude: claudePath, status };
}

export function markAdopted(root: string, path: string, date = new Date().toISOString().slice(0, 10)): RepoMap {
  const map = readRepoMap(root);
  if (!map) throw new Error(`no ${REPO_MAP_JSON} – run repo-map.ts first`);
  const wanted = path.replace(/\/$/, "");
  const pkg = map.packages.find((p) => p.path === wanted || p.name === wanted);
  if (!pkg) throw new Error(`package '${path}' is not in the repository map`);
  pkg.adopted = true;
  pkg.adoptedAt = date;
  writeRepoMap(root, map);
  writeRootBlock(root, map);
  return map;
}

/** Stable view for staleness checks: generated docs and ranking may change with history. */
export function stableMap(map: RepoMap): string {
  const packages = [...map.packages]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map(({ adopted: _adopted, adoptedAt: _adoptedAt, consumers: _consumers, ...rest }) => rest);
  return JSON.stringify({ version: map.version, tooling: map.tooling, packages }, null, 2);
}

export function findPackage(map: RepoMap, path: string): RepoPackage | undefined {
  const wanted = path.replace(/\/$/, "");
  return map.packages.find((p) => p.path === wanted || p.name === wanted);
}

export function ensureInside(root: string, path: string): string {
  const absolute = resolve(root, path);
  const rel = relative(resolve(root), absolute);
  if (rel.startsWith("..") || resolve(rel) === rel) throw new Error(`'${path}' is outside the repository`);
  return absolute;
}
