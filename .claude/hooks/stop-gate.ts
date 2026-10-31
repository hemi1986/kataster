/**
 * Stop hook: quick gate before Claude finishes a turn in which application code changed.
 *
 * Runs the type check and the tests related to the changed files (Vitest). If they fail, Claude is sent back
 * once to fix them (exit 2); `stop_hook_active` prevents a loop – the second time it only reports.
 * The full gate is `node .claude/skills/implement/scripts/verify.ts`.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../lib/discovery.ts";
import { appBin, git, isCode } from "../lib/engineering.ts";

let data: Record<string, any>;
try {
  data = JSON.parse(readFileSync(0, "utf8"));
} catch {
  process.exit(0);
}
if (data.stop_hook_active) process.exit(0);

const changed = (git("status", "--porcelain", "--untracked-files=all") ?? "")
  .split("\n")
  .map((l) => l.slice(3).trim().replace(/^.* -> /, ""))
  .filter((f) => f && !f.startsWith(".claude/") && !f.startsWith("docs/") && isCode(f) && existsSync(join(ROOT, f)));
if (!changed.length) process.exit(0);

const failures: string[] = [];
const tail = (s: string) => s.trim().split("\n").slice(-40).join("\n");

const tsc = appBin("tsc");
if (tsc && existsSync(join(ROOT, "tsconfig.json"))) {
  const r = spawnSync(tsc, ["--noEmit", "-p", "."], { cwd: ROOT, encoding: "utf8", timeout: 240_000 });
  if (r.status !== 0) failures.push(`Type check failed:\n${tail(r.stdout + r.stderr)}`);
}
const vitest = appBin("vitest");
if (vitest) {
  const r = spawnSync(vitest, ["related", "--run", "--passWithNoTests", ...changed], { cwd: ROOT, encoding: "utf8", timeout: 300_000 });
  if (r.status !== 0) failures.push(`Tests related to the changed files failed:\n${tail(r.stdout + r.stderr)}`);
}

// Project-owned checks from docs/engineering/checks.yaml (boundaries, architecture tests, …).
const project = spawnSync(process.execPath, [join(ROOT, ".claude", "hooks", "project-check.ts"), "--phase", "stop"], {
  cwd: ROOT,
  encoding: "utf8",
  timeout: 120_000,
});
if (project.status !== 0) {
  failures.push(`Project checks failed:\n${tail(`${project.stdout ?? ""}${project.stderr ?? ""}`)}`);
}

if (failures.length) {
  process.stderr.write(`Quick gate is red – fix before finishing (or say explicitly why it is red on purpose, e.g. a failing test in the red step):\n\n${failures.join("\n\n")}\n`);
  process.exit(2);
}
process.exit(0);
