/**
 * The one quality gate – used by /implement, CI (`verify` in the project's task runner) and developers.
 *
 *   1. Project checks, from `commands` in `.claude/project.json` (falling back to the root package.json
 *      scripts): lint (incl. module boundary rules), typecheck, test (with --e2e also test:e2e)
 *   2. Discovery artifacts: events.yaml and stories are valid
 *   3. Traceability: scenario ↔ test titles, domain IDs in the code
 *   4. Glossary language (warnings only)
 *
 * Writes the result to .claude/state/last-verify.json (shown at session start). Exit 1 if any step failed.
 *
 * Usage: node verify.ts [--e2e]
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as d from "../../../lib/discovery.ts";
import * as e from "../../../lib/engineering.ts";

const here = import.meta.dirname;
const steps: e.VerifyState["steps"] = [];

function run(name: string, command: string, args: string[] = [], advisory = false): void {
  console.log(`\n━━ ${name} ━━`);
  const r = spawnSync(command, args, { cwd: d.ROOT, stdio: "inherit" });
  const ok = r.status === 0;
  steps.push({ name, ok: ok || advisory });
  if (!ok) console.log(advisory ? `⚠ ${name} (advisory, not blocking)` : `✗ ${name} failed`);
}

function shell(name: string, command: string): void {
  console.log(`\n━━ ${name} ━━\n$ ${command}`);
  const r = spawnSync(command, { cwd: d.ROOT, stdio: "inherit", shell: true });
  const ok = r.status === 0;
  steps.push({ name, ok });
  if (!ok) console.log(`✗ ${name} failed`);
}

/** Commands from the project profile; empty values are skipped. */
function profileCommands(): Record<string, string> {
  const file = join(d.ROOT, ".claude", "project.json");
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8")).commands ?? {};
  } catch {
    return {};
  }
}

const commands = profileCommands();
const appSteps = ["lint", "typecheck", "test", ...(process.argv.includes("--e2e") ? ["e2e"] : [])];
const scripts = e.appScripts();
const configured = appSteps.filter((s) => commands[s]);
const fallback = appSteps.filter((s) => !commands[s] && scripts[s]);

if (!configured.length && !fallback.length) {
  console.log(
    "━━ project ━━\nNo lint/typecheck/test commands configured in `.claude/project.json` and no root package.json scripts – project checks skipped.",
  );
}
for (const s of configured) shell(s, commands[s]);
for (const s of fallback) run(`npm run ${s}`, "npm", ["run", s]);
for (const s of appSteps.filter((s) => !commands[s] && !scripts[s])) {
  if (Object.keys(commands).length || Object.keys(scripts).length) {
    console.log(`\n━━ ${s} ━━\nno '${s}' command configured – skipped`);
    steps.push({ name: s, ok: true, skipped: true });
  }
}

const node = process.execPath;
const disc = join(here, "..", "..");
run("events.yaml", node, [join(disc, "event-storming", "scripts", "validate-events.ts")]);
run("stories", node, [join(disc, "user-stories", "scripts", "validate-stories.ts")]);
// The map is generated; staleness is a warning (adoption may not have run yet), not a failed gate.
run("repository map", node, [join(disc, "adopt", "scripts", "repo-map.ts"), "--check"], true);
run("path-scoped rules", node, [join(disc, "adopt", "scripts", "rule-doc.ts"), "--check"], true);
run("project checks", node, [join(d.ROOT, ".claude", "hooks", "project-check.ts"), "--phase", "stop"]);
run("scenario ↔ test traceability", node, [join(here, "check-scenarios.ts")]);
run("domain ID traceability", node, [join(here, "check-commands.ts")]);
run("glossary language", node, [join(here, "check-language.ts")], true);

const ok = steps.every((s) => s.ok);
e.writeVerifyState({
  at: new Date().toISOString(),
  branch: e.git("rev-parse", "--abbrev-ref", "HEAD"),
  commit: e.git("rev-parse", "--short", "HEAD"),
  dirty: (e.git("status", "--porcelain") ?? "") !== "",
  ok,
  steps,
});
console.log(`\n${ok ? "✓ verify passed" : "✗ verify FAILED: " + steps.filter((s) => !s.ok).map((s) => s.name).join(", ")}`);
process.exit(ok ? 0 : 1);
