/**
 * Architecture boundary check with baseline/ratchet.
 *
 *   node .claude/skills/adopt/scripts/boundary-check.ts --init
 *   node .claude/skills/adopt/scripts/boundary-check.ts
 *   node .claude/skills/adopt/scripts/boundary-check.ts --changed [file]
 *   node .claude/skills/adopt/scripts/boundary-check.ts --update-baseline
 *   node .claude/skills/adopt/scripts/boundary-check.ts --json
 *
 * `--init` writes a proposal for `docs/architecture/boundaries.yaml`, the default `docs/engineering/checks.yaml`
 * and an empty baseline. The user confirms the rules during /adopt; `--update-baseline` freezes violations that
 * already exist, so only new ones fail.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  BOUNDARIES_FILE, BASELINE_FILE, CHECKS_FILE, adapterHints, baselineFrom, checkBoundaries, defaultChecks, defaultRules,
  emptyBaseline, evaluateBaseline, formatViolation, loadBaseline, loadBoundaries, relPath, rootMap,
  writeBaseline, writeBoundaries, writeChecks,
} from "../../../lib/architecture.ts";
import { ROOT } from "../../../lib/repo.ts";

const args = process.argv.slice(2);
const help = args.includes("--help") || args.includes("-h");
const init = args.includes("--init");
const update = args.includes("--update-baseline");
const json = args.includes("--json");

function usage(): void {
  console.log(
    [
      "Usage: node .claude/skills/adopt/scripts/boundary-check.ts [options]",
      "",
      "  --init                 write a boundaries.yaml proposal, checks.yaml and an empty baseline",
      "  --force                with --init: overwrite existing files",
      "  --changed [file]       check only this file (or $CHANGED_FILE, used by the edit hook)",
      "  --update-baseline      freeze current violations so only new ones fail",
      "  --json                 machine-readable result",
    ].join("\n"),
  );
}

if (help) {
  usage();
  process.exit(0);
}

try {
  if (init) {
    const map = rootMap(ROOT);
    const force = args.includes("--force");
    if (!force) {
      for (const file of [BOUNDARIES_FILE, CHECKS_FILE, BASELINE_FILE]) {
        if (existsSync(join(ROOT, file))) throw new Error(`${file} already exists – edit it, or pass --force`);
      }
    }
    const boundaries = { version: 1 as const, engine: "auto" as const, command: "", rules: defaultRules(map) };
    const boundariesPath = writeBoundaries(ROOT, boundaries, force);
    const checksPath = writeChecks(ROOT, { version: 1, checks: defaultChecks() }, force);
    const baselinePath = writeBaseline(ROOT, emptyBaseline());
    console.log(`Wrote ${relPath(ROOT, boundariesPath)} with ${boundaries.rules.length} proposed rule(s).`);
    console.log(`Wrote ${relPath(ROOT, checksPath)} and ${relPath(ROOT, baselinePath)}.`);
    if (!boundaries.rules.length) {
      console.log("No apps/, services/, libs/ or packages/ directories were found – add the rules by hand.");
    }
    for (const hint of adapterHints(map)) console.log(`Hint: ${hint}`);
    console.log("Review and confirm the rules with the user, then freeze existing violations:");
    console.log("  node .claude/skills/adopt/scripts/boundary-check.ts --update-baseline");
    process.exit(0);
  }

  const changedIndex = args.indexOf("--changed");
  const changedArg = changedIndex === -1 ? undefined : args[changedIndex + 1];
  const changed = changedIndex === -1
    ? undefined
    : changedArg && !changedArg.startsWith("--")
      ? relPath(ROOT, changedArg)
      : process.env.CHANGED_FILE
        ? relPath(ROOT, process.env.CHANGED_FILE)
        : undefined;

  if (update && changed) {
    console.error("--update-baseline must run without --changed – freezing a single file would drop the rest.");
    process.exit(1);
  }

  const boundaries = loadBoundaries(ROOT);
  if (!boundaries) {
    console.log(`No ${BOUNDARIES_FILE} – architecture boundaries are not configured yet.`);
    console.log("Run `node .claude/skills/adopt/scripts/boundary-check.ts --init` during /adopt.");
    process.exit(0);
  }

  if (!boundaries.rules.length && boundaries.engine !== "command") {
    console.log("No boundary rules configured – nothing to check.");
    process.exit(0);
  }

  const map = rootMap(ROOT);
  const result = checkBoundaries(ROOT, boundaries, map, changed);

  if (update) {
    const path = writeBaseline(ROOT, baselineFrom(result));
    const command = result.command ? ` and the command failure` : "";
    console.log(`Baseline written to ${relPath(ROOT, path)}: ${result.violations.length} violation(s)${command} frozen.`);
    process.exit(0);
  }

  const report = evaluateBaseline(result, loadBaseline(ROOT));

  if (json) {
    console.log(JSON.stringify({
      ok: report.ok,
      engine: report.engine,
      checked: report.checked,
      violations: report.violations.length,
      new: report.newViolations,
      stale: report.stale,
      command: report.command ? { name: report.command.name, baselined: report.commandBaselined, output: report.command.output } : undefined,
      note: report.note,
    }, null, 2));
    process.exit(report.ok ? 0 : 1);
  }

  if (report.note) console.log(report.note);
  const unit = report.engine === "scan" ? "import edge(s)" : "check(s)";
  console.log(`Architecture boundaries (${report.engine}): ${report.checked} ${unit}, ${report.violations.length} violation(s).`);

  if (report.command && !report.commandBaselined) {
    console.error(`\nThe architecture command failed (not baselined):\n${report.command.output}`);
    process.exit(1);
  }

  if (report.newViolations.length) {
    const shown = report.newViolations.slice(0, 50);
    console.error(`\nNew boundary violations – fix them or, if they are existing debt, freeze them with --update-baseline:\n${shown.map(formatViolation).join("\n")}`);
    if (report.newViolations.length > shown.length) {
      console.error(`… and ${report.newViolations.length - shown.length} more (see --json).`);
    }
    process.exit(1);
  }

  if (report.violations.length) {
    console.log(`${report.violations.length} baselined violation(s) – existing debt, not failing.`);
  }
  if (report.stale.length) {
    console.log(`${report.stale.length} baseline entr${report.stale.length === 1 ? "y" : "ies"} no longer occur – update the baseline to tighten the ratchet.`);
  }
  if (report.command && report.commandBaselined) {
    console.log("The architecture command failure is baselined.");
  }
  console.log("OK – no new boundary violations.");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
