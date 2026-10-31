/**
 * Which packages are affected by a change, and the command that tests exactly them.
 *
 *   node .claude/skills/implement/scripts/affected.ts --changed apps/billing/src/index.ts
 *   node .claude/skills/implement/scripts/affected.ts --base origin/main
 *   node .claude/skills/implement/scripts/affected.ts --task lint --run
 *   node .claude/skills/implement/scripts/affected.ts --json
 *
 * The package graph comes from `docs/architecture/repo-map.json` (manifests) plus the optional build-tool
 * `toolGraph` (Turbo, Nx, Bazel). Dependents are followed transitively: touching a shared library selects the
 * packages that depend on it. The command is emitted in the repository's own tool (Turbo filters, Nx
 * run-many, Bazel, …); `--run` executes it.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { ROOT, readRepoMap, scanRepo, type RepoMap, type RepoPackage } from "../../../lib/repo.ts";

const args = process.argv.slice(2);

function usage(): void {
  console.log(
    [
      "Usage: node .claude/skills/implement/scripts/affected.ts [options]",
      "",
      "  --changed <file>   a changed file (repeatable or comma-separated; default: git status)",
      "  --base <ref>       use git diff against this ref (e.g. origin/main)",
      "  --task <name>      task to run (default: test)",
      "  --run              execute the emitted command",
      "  --json             machine-readable result",
    ].join("\n"),
  );
}

if (args.includes("--help") || args.includes("-h")) {
  usage();
  process.exit(0);
}

const json = args.includes("--json");
const run = args.includes("--run");

const changed: string[] = [];
let base = "";
let task = "test";
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--changed") {
    const value = args[i + 1];
    if (!value || value.startsWith("--")) continue;
    changed.push(...value.split(",").map((f) => f.trim()).filter(Boolean));
    i += 1;
  } else if (args[i] === "--base") {
    const value = args[i + 1];
    if (value && !value.startsWith("--")) {
      base = value;
      i += 1;
    }
  } else if (args[i] === "--task") {
    const value = args[i + 1];
    if (value && !value.startsWith("--")) {
      task = value;
      i += 1;
    }
  }
}

if (changed.length && base) {
  console.error("Use either --changed or --base, not both.");
  process.exit(1);
}

function git(args: string[]): string[] {
  try {
    return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function changedFiles(): string[] {
  if (changed.length) return [...new Set(changed.map((f) => relative(ROOT, resolve(ROOT, f)).split("\\").join("/")))];
  if (base) return git(["diff", "--name-only", base]);
  return git(["status", "--porcelain", "--untracked-files=all"])
    .map((line) => line.slice(3).trim().replace(/^.* -> /, ""))
    .filter(Boolean);
}

function packageForFile(map: RepoMap, file: string): RepoPackage | undefined {
  return map.packages
    .filter((p) => p.path === "." || file === p.path || file.startsWith(`${p.path}/`))
    .sort((a, b) => b.path.length - a.path.length)[0];
}

function dependentsOf(map: RepoMap): Map<string, Set<string>> {
  const byName = new Map(map.packages.map((p) => [p.name, p]));
  const dependents = new Map<string, Set<string>>();
  const add = (from: string, to: string): void => {
    if (!byName.has(from) || !byName.has(to) || from === to) return;
    dependents.set(to, new Set([...(dependents.get(to) ?? []), from]));
  };
  for (const pkg of map.packages) for (const dep of pkg.internalDeps) add(pkg.name, dep);
  for (const edge of map.toolGraph?.edges ?? []) add(edge.from, edge.to);
  return dependents;
}

/** Turbo/pnpm/npm only run a task where the package defines the script; Nx/Bazel may infer targets. */
function runnableForTask(map: RepoMap, packages: RepoPackage[], task: string): RepoPackage[] {
  switch (map.tooling.kind) {
    case "turbo":
    case "pnpm":
    case "workspaces":
    case "none":
      return packages.filter((p) => Boolean(p.scripts[task]));
    default:
      return packages;
  }
}

function commandFor(map: RepoMap, packages: RepoPackage[], all: boolean): string {
  const names = packages.map((p) => p.name);
  const paths = packages.map((p) => p.path);
  if (all) {
    switch (map.tooling.kind) {
      case "turbo": return `turbo run ${task}`;
      case "nx": return `nx run-many -t ${task}`;
      case "bazel": return `bazel ${task} //...`;
      case "pnpm": return `pnpm -r ${task}`;
      case "workspaces":
        if (map.tooling.manager === "yarn") return `yarn workspaces run ${task}`;
        if (map.tooling.manager === "bun") return `bun run --filter '*' ${task}`;
        return `npm run ${task} --workspaces`;
      case "go-work": return `go ${task} ./...`;
      case "cargo-workspace": return `cargo ${task} --workspace`;
      case "gradle": return `./gradlew ${task}`;
      case "maven": return `mvn ${task}`;
      default: return existsSync(join(ROOT, "package.json")) ? `npm run ${task}` : "";
    }
  }

  switch (map.tooling.kind) {
    case "turbo":
      if (base) return `turbo run ${task} --filter='...[${base}]'`;
      return names.length ? `turbo run ${task} ${names.map((n) => `--filter=${n}`).join(" ")}` : "";
    case "nx": {
      if (base) return `nx affected -t ${task} --base=${base}`;
      const projects = packages.map(
        (p) => map.toolGraph?.projectNames?.[p.name] ?? p.projectName ?? p.name.replace(/^@[^/]+\//, ""),
      );
      return projects.length ? `nx run-many -t ${task} -p ${projects.join(",")}` : "";
    }
    case "bazel":
      return paths.length ? `bazel ${task} ${paths.map((p) => `//${p}/...`).join(" ")}` : "";
    case "pnpm":
      return names.length ? `pnpm ${names.map((n) => `--filter=${n}`).join(" ")} ${task}` : "";
    case "workspaces":
      if (map.tooling.manager === "yarn") return names.map((n) => `yarn workspace ${n} ${task}`).join(" && ");
      if (map.tooling.manager === "bun") return names.length ? `bun run ${names.map((n) => `--filter=${n}`).join(" ")} ${task}` : "";
      return names.length ? `npm run ${task} ${names.map((n) => `--workspace=${n}`).join(" ")}` : "";
    case "go-work":
      return paths.length ? `go ${task} ${paths.map((p) => `./${p}/...`).join(" ")}` : "";
    case "cargo-workspace":
      return names.length ? `cargo ${task} ${names.map((n) => `-p ${n}`).join(" ")}` : "";
    case "gradle":
      return paths.length ? `./gradlew ${paths.map((p) => `:${p.split("/").join(":")}:${task}`).join(" ")}` : "";
    case "maven":
      return paths.length ? `mvn -pl ${paths.join(",")} ${task}` : "";
    default:
      return packages.length === 1 && packages[0].scripts[task]
        ? `npm --prefix ${packages[0].path} run ${task}`
        : "";
  }
}

const map = readRepoMap(ROOT) ?? scanRepo(ROOT, { toolGraph: false });
const files = changedFiles();
const changedPackages = new Map<string, RepoPackage>();
const IGNORED_CHANGED = /^(docs|\.claude|\.opencode|\.github)\//;
let all = false;
for (const file of files) {
  const pkg = packageForFile(map, file);
  if (pkg) changedPackages.set(pkg.name, pkg);
  else if (!IGNORED_CHANGED.test(file)) all = true; // root config or an unmapped file can affect everything
}

const dependents = dependentsOf(map);
const affected = new Map(changedPackages);
const queue = [...changedPackages.keys()];
while (queue.length) {
  const name = queue.shift()!;
  for (const dependent of dependents.get(name) ?? []) {
    if (affected.has(dependent)) continue;
    const pkg = map.packages.find((p) => p.name === dependent);
    if (pkg) {
      affected.set(dependent, pkg);
      queue.push(dependent);
    }
  }
}

const packages = (all ? map.packages : [...affected.values()]).sort((a, b) => a.path.localeCompare(b.path));
const runnable = runnableForTask(map, packages, task);
const command = commandFor(map, runnable, all);
const source = map.toolGraph
  ? `${map.toolGraph.source}:${map.toolGraph.task ?? "graph"}+manifests`
  : "manifests";

if (json) {
  console.log(JSON.stringify({
    changed: files,
    changedPackages: [...changedPackages.values()].map((p) => p.path),
    affected: packages.map((p) => ({ name: p.name, path: p.path })),
    all,
    task,
    base: base || null,
    source,
    command,
  }, null, 2));
  process.exit(0);
}

console.log(`Changed files: ${files.length}`);
if (!files.length) {
  console.log("No changed files found – nothing to do.");
  process.exit(0);
}
console.log(`Affected packages (${source}): ${packages.length}${all ? " (all – a root file changed)" : ""}`);
for (const pkg of packages) console.log(`- ${pkg.path} (${pkg.name})${changedPackages.has(pkg.name) ? " – changed" : ""}`);
if (runnable.length !== packages.length) {
  console.log(`Only ${runnable.length} of them define a '${task}' task.`);
}
if (!packages.length) {
  console.log("No package matched the changed files – run the full gate (verify.ts).");
  process.exit(0);
}
console.log("");
console.log(`Command:\n  ${command || "(no command for this tooling – run verify.ts)"}`);

if (run) {
  if (!command) process.exit(1);
  const result = spawnSync(command, { cwd: ROOT, shell: true, stdio: "inherit" });
  process.exit(result.status ?? 1);
}
