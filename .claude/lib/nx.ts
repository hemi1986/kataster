/**
 * Nx adapter.
 *
 * Nx already knows the project graph – including inferred targets and projects without a manifest. Instead
 * of re-implementing it, `repo-map.ts` asks once with `nx graph --file=<temp>` (writes JSON, starts no
 * server) and stores the result as an optional `toolGraph`. If Nx is not installed, the command fails, or it
 * times out, the map falls back to manifests.
 *
 * Nx project names need not equal package names (`billing` vs `@acme/billing`). Nodes are resolved by their
 * `root` path, so the graph always speaks in repository package names; the original project names are kept
 * in `projectNames` so `affected.ts` can emit `nx run-many -p …`.
 *
 * Node >= 22.18, erasable TypeScript only, no runtime dependency.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GraphPackage, ToolGraph } from "./toolgraph.ts";

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** `./apps/a/` → `apps/a`; `""` and `"."` → `"."`. */
function normalizePackagePath(path: string): string {
  const trimmed = path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  return trimmed === "" || trimmed === "." ? "." : trimmed;
}

export function nxBinary(root: string): string | undefined {
  const name = process.platform === "win32" ? "nx.cmd" : "nx";
  for (const candidate of [join(root, "node_modules", ".bin", name), join(root, "node_modules", ".bin", "nx")]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Parses the file written by `nx graph --file`. Kept pure so it can be tested without Nx installed.
 * Accepts both the wrapped (`{ graph: { nodes, dependencies } }`) and the bare (`{ nodes, dependencies }`)
 * shape, and dependencies as objects (`{ source, target }`) or plain name strings.
 */
export function parseNxGraph(data: unknown, packages: GraphPackage[]): ToolGraph | undefined {
  if (!isObject(data)) return undefined;
  const graph = isObject(data.graph) ? data.graph : data;
  const nodes = isObject(graph.nodes) ? graph.nodes : undefined;
  if (!nodes) return undefined;
  const dependencies = isObject(graph.dependencies) ? graph.dependencies : {};

  const packageByPath = new Map(packages.map((pkg) => [normalizePackagePath(pkg.path), pkg.name]));
  const packageOfProject = new Map<string, string>();
  const projectOfPackage = new Map<string, string>();

  for (const [key, raw] of Object.entries(nodes)) {
    if (!isObject(raw)) continue;
    const info = isObject(raw.data) ? raw.data : raw;
    const project = typeof raw.name === "string" && raw.name ? raw.name : key;
    const root = typeof info.root === "string" ? info.root : undefined;
    if (!root) continue;
    const name = packageByPath.get(normalizePackagePath(root));
    if (!name) continue;
    packageOfProject.set(project, name);
    packageOfProject.set(key, name);
    if (!projectOfPackage.has(name)) projectOfPackage.set(name, project);
  }
  if (!packageOfProject.size) return undefined;

  const edges = new Map<string, { from: string; to: string }>();
  const add = (fromProject: unknown, toProject: unknown): void => {
    if (typeof fromProject !== "string" || typeof toProject !== "string") return;
    const from = packageOfProject.get(fromProject);
    const to = packageOfProject.get(toProject);
    if (!from || !to || from === to) return;
    edges.set(`${from}>${to}`, { from, to });
  };

  for (const [source, list] of Object.entries(dependencies)) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (typeof item === "string") add(source, item);
      else if (isObject(item)) add(item.source ?? source, item.target);
    }
  }

  const sorted = [...edges.values()].sort((a, b) => `${a.from}>${a.to}`.localeCompare(`${b.from}>${b.to}`));
  return {
    source: "nx",
    packages: [...new Set(projectOfPackage.keys())].sort(),
    edges: sorted,
    projectNames: Object.fromEntries([...projectOfPackage].sort(([a], [b]) => a.localeCompare(b))),
  };
}

/** Ask Nx for its project graph. Returns undefined when Nx is absent, fails, or does not answer in time. */
export function queryNxGraph(root: string, packages: GraphPackage[]): ToolGraph | undefined {
  const binary = nxBinary(root);
  if (!binary) return undefined;

  let dir: string;
  try {
    dir = mkdtempSync(join(tmpdir(), "kataster-nx-"));
  } catch {
    return undefined;
  }
  const file = join(dir, "graph.json");
  try {
    // `graph` is Nx 16+; `dep-graph` is the pre-16 name. Try both, the first answer wins.
    for (const command of ["graph", "dep-graph"]) {
      const result = spawnSync(binary, [command, `--file=${file}`], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30_000,
        env: { ...process.env, NX_DAEMON: "false", NX_INTERACTIVE: "false", NX_TELEMETRY: "false" },
      });
      if (result.status !== 0 || !existsSync(file)) continue;
      const text = readFileSync(file, "utf8").trim();
      const start = text.indexOf("{");
      const end = text.lastIndexOf("}");
      if (start === -1 || end <= start) continue;
      const graph = parseNxGraph(JSON.parse(text.slice(start, end + 1)), packages);
      if (graph) return graph;
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
