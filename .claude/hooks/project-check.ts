/**
 * Project-check dispatcher – one hook, project-owned checks.
 *
 *   docs/engineering/checks.yaml lists checks with a `phase` (edit | stop | ci), optional `paths` globs,
 *   a timeout and an optional `advisory` flag. This script runs the checks for the phase:
 *
 *     edit  – after Write/Edit (PostToolUse); only checks whose `paths` match the changed file
 *     stop  – full set; called by the stop gate and by `verify.ts`
 *
 * It is wired into both harnesses once (Claude settings, OpenCode plugin). Adding a check never touches the
 * hook wiring; adding an arbitrary hook per package is deliberately not supported.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { loadChecks, matchesAny, relPath, type Phase } from "../lib/architecture.ts";
import { ROOT } from "../lib/repo.ts";

const args = process.argv.slice(2);
const phaseArg = args[args.indexOf("--phase") + 1];
const phase: Phase = phaseArg === "stop" || phaseArg === "ci" ? phaseArg : "edit";
const changedIndex = args.indexOf("--changed");
const changedArg = changedIndex === -1 ? undefined : args[changedIndex + 1];

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function tail(text: string, lines = 40): string {
  return text.trim().split("\n").slice(-lines).join("\n");
}

let changed = changedArg && !changedArg.startsWith("--") ? changedArg : process.env.CHANGED_FILE;

if (phase === "edit" && !changed && !process.stdin.isTTY) {
  // The hook payload carries the changed file; a stop/CI run has none.
  try {
    const raw = readFileSync(0, "utf8").trim();
    if (raw) {
      const data = JSON.parse(raw) as { cwd?: string; tool_input?: { file_path?: unknown } };
      const fp = data.tool_input?.file_path;
      if (typeof fp === "string" && fp) changed = isAbsolute(fp) ? fp : join(data.cwd ?? ROOT, fp);
    }
  } catch {
    // no stdin or malformed payload – there is nothing to scope an edit check to
  }
}

if (changed) changed = relPath(ROOT, changed);

try {
  const config = loadChecks(ROOT);
  const checks = config?.checks ?? [];
  if (!checks.length) process.exit(0);
  if (phase === "edit" && !changed) process.exit(0);

  const failures: string[] = [];
  const notes: string[] = [];

  for (const check of checks) {
    if (check.phase !== phase) continue;
    // `paths` scopes the edit-time check. Stop/CI runs the full set.
    if (phase === "edit" && check.paths.length) {
      if (!changed) continue;
      if (!matchesAny(changed, check.paths)) continue;
    }

    const command = check.command.replaceAll("{changed}", changed ? shellQuote(changed) : "");
    const result = spawnSync(command, {
      cwd: ROOT,
      shell: true,
      encoding: "utf8",
      timeout: check.timeout * 1000,
      env: { ...process.env, CHANGED_FILE: changed ?? "", KATASTER_PHASE: phase },
    });
    const ok = result.status === 0;
    if (ok) continue;

    const timedOut = result.error && "code" in result.error && result.error.code === "ETIMEDOUT";
    const detail = timedOut
      ? `timed out after ${check.timeout}s`
      : tail(`${result.stdout ?? ""}${result.stderr ?? ""}`) || `exit ${result.status ?? "?"}`;
    const block = `── ${check.name} ──\n${detail}`;
    if (check.advisory) notes.push(block);
    else failures.push(block);
  }

  if (failures.length) {
    process.stderr.write(
      `Project checks failed – fix before continuing:\n\n${failures.join("\n\n")}\n\n` +
        "A brownfield violation that already existed belongs in the baseline (boundary-check --update-baseline), not in a red hook.\n",
    );
    process.exit(2);
  }

  if (notes.length) {
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: phase === "edit" ? "PostToolUse" : "Stop",
        additionalContext: `Project checks (advisory):\n\n${notes.join("\n\n")}`,
      },
    }));
  }
  process.exit(0);
} catch (error) {
  process.stderr.write(`Project check configuration is broken:\n${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
}
