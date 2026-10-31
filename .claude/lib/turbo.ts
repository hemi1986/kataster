/**
 * Turborepo adapter.
 *
 * Turborepo already knows the package graph and the task graph. Instead of re-implementing it, `repo-map.ts`
 * asks it once with `turbo run <task> --dry=json` (dry: no task runs) and stores the result as an optional
 * `toolGraph` next to the manifest graph. If Turbo is not installed, the command fails, or it times out, the
 * map falls back to manifests – the workflow never depends on the tool being present.
 *
 * `affected.ts` uses the graph for the fast test loop; Turbo itself still gets the final `--filter` command.
 *
 * Node >= 22.18, erasable TypeScript only, no runtime dependency.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolGraph } from "./toolgraph.ts";

interface TurboTask {
  package?: string;
  taskId?: string;
  dependencies?: unknown;
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** Minimal JSONC support: turbo.json is JSON, but some repositories keep comments in it. */
function parseJsonc(text: string): unknown {
  let out = "";
  let inString = false;
  let quote = "";
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    const next = text[i + 1];
    if (inString) {
      out += c;
      if (c === "\\") {
        out += next ?? "";
        i += 1;
      } else if (c === quote) {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      quote = c;
      out += c;
      continue;
    }
    if (c === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      out += "\n";
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 1;
      continue;
    }
    out += c;
  }
  try {
    return JSON.parse(out.replace(/,\s*([}\]])/g, "$1"));
  } catch {
    return undefined;
  }
}

/** The task to ask Turbo about: build, else test, else lint, else the first configured task. */
export function turboTaskNames(root: string): string[] {
  const text = readText(join(root, "turbo.json"));
  if (text === undefined) return [];
  const config = parseJsonc(text);
  if (!isObject(config)) return [];
  const block = isObject(config.tasks) ? config.tasks : isObject(config.pipeline) ? config.pipeline : {};
  return Object.keys(block).filter((key) => !key.startsWith("$")).sort();
}

export function pickTurboTask(root: string): string | undefined {
  const tasks = turboTaskNames(root);
  for (const wanted of ["build", "test", "lint", "typecheck"]) if (tasks.includes(wanted)) return wanted;
  return tasks[0];
}

export function turboBinary(root: string): string | undefined {
  const name = process.platform === "win32" ? "turbo.cmd" : "turbo";
  for (const candidate of [join(root, "node_modules", ".bin", name), join(root, "node_modules", ".bin", "turbo")]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function packageOfTask(task: TurboTask): string | undefined {
  if (typeof task.package === "string" && task.package) return task.package;
  if (typeof task.taskId === "string") return task.taskId.split("#")[0];
  return undefined;
}

/** Parses the `--dry=json` output. Kept pure so it can be tested without a Turbo installation. */
export function parseTurboDry(data: unknown, task: string): ToolGraph | undefined {
  if (!isObject(data)) return undefined;
  const tasks: TurboTask[] = Array.isArray(data.tasks)
    ? data.tasks.filter(isObject) as TurboTask[]
    : isObject(data.tasks)
      ? Object.values(data.tasks).filter(isObject) as TurboTask[]
      : [];
  if (!tasks.length) return undefined;

  const packages = new Set<string>();
  const edges = new Map<string, { from: string; to: string }>();
  for (const item of tasks) {
    const from = packageOfTask(item);
    if (!from) continue;
    packages.add(from);
    for (const dep of list(item.dependencies)) {
      if (!dep.includes("#")) continue; // unresolved task pattern such as "^build"
      const to = dep.split("#")[0];
      if (!to || to === from) continue;
      packages.add(to);
      edges.set(`${from}>${to}`, { from, to });
    }
  }
  if (!packages.size) return undefined;
  return {
    source: "turbo",
    task,
    packages: [...packages].sort(),
    edges: [...edges.values()].sort((a, b) => `${a.from}>${a.to}`.localeCompare(`${b.from}>${b.to}`)),
  };
}

/** Ask Turbo for its graph. Returns undefined when Turbo is absent, fails, or does not answer in time. */
export function queryTurboGraph(root: string): ToolGraph | undefined {
  const binary = turboBinary(root);
  const task = pickTurboTask(root);
  if (!binary || !task) return undefined;

  const result = spawnSync(binary, ["run", task, "--dry=json"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 20_000,
    env: { ...process.env, TURBO_TELEMETRY_DISABLED: "1" },
  });
  if (result.status !== 0 || !result.stdout) return undefined;

  const text = result.stdout.trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return undefined;
  try {
    return parseTurboDry(JSON.parse(text.slice(start, end + 1)), task);
  } catch {
    return undefined;
  }
}
