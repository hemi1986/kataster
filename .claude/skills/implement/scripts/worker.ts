/**
 * The worker mode of `/implement` (`--worker ST-NNN --base <branch>`) – the two mechanical ends of a pass.
 *
 *   start  ST-NNN --base <branch> [--json]
 *       Checks what a pass needs (the base exists, the tree is clean, the story is `ready` on the base and linked to
 *       the tracker) and puts the checkout on the story branch: a first pass creates it from the base, a
 *       continuation switches to the branch that exists. Never pulls, never picks a story. Exit 1 = the pass cannot
 *       start; nothing was switched and the worker reports `blocked`.
 *
 *   report ST-NNN --base <branch> --result ready-for-review|blocked|returned-to-review [--details <file>|-]
 *       Prints the report the worker hands back, as one JSON block. Branch, commits, changed files and the verify
 *       result are read from git and the last verify.ts run; the worker passes only its judgement as JSON (`reason`,
 *       `newTerms`, `adrProposals`, `openQuestions`, `findings`). Exit 1 = the result contradicts the facts (e.g.
 *       `ready-for-review` without a green verify on the branch head); no report is printed.
 *
 * In a running marathon run the worker holds the run's lease (lib/lease.ts): `start` makes the calling session the
 * worker of the claimed story – an earlier worker of it is superseded and blocked from then on – and `report`
 * refuses a session that is not that worker, and keeps the report for a resumed orchestrator
 * (.claude/state/marathon-reports/ST-NNN.json). `--caller` is appended by the hooks, never typed.
 *
 * Harness-neutral: Claude Code and OpenCode run the same commands.
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "../../../lib/args.ts";
import { ROOT } from "../../../lib/discovery.ts";
import * as e from "../../../lib/engineering.ts";
import { gitRaw } from "../../../lib/git.ts";
import { isSuperseded, readLease, takeWorker, workerError } from "../../../lib/lease.ts";
import { keepReport, updateLease } from "../../../lib/marathon.ts";
import * as w from "../../../lib/worker.ts";

const USAGE = `Usage:
  node .claude/skills/implement/scripts/worker.ts start  ST-NNN --base <branch> [--json]
  node .claude/skills/implement/scripts/worker.ts report ST-NNN --base <branch> --result <result> [--details <file>|-]

  --base <branch>    the branch the story branch is cut from and compared with (never pulled)
  --result <result>  ${w.WORKER_RESULTS.join(" | ")}
  --details <file>   the worker's part of the report as JSON; '-' reads it from stdin:
                     { "reason": "…",
                       "newTerms":      [{ "term": "…", "meaning": "…" }],
                       "adrProposals":  [{ "title": "…", "why": "…" }],
                       "openQuestions": [{ "question": "…", "kind": "domain|technical" }],
                       "decisions":     [{ "question": "…", "decision": "…", "why": "…" }],
                       "findings":      [{ "finding": "…", "action": "fixed|skipped|open" }] }
                     Write it to a file (e.g. .kataster/details/ST-NNN-report.json) – a heredoc is refused
                     by Claude Code's dontAsk mode.
  --json             (start) machine-readable`;

const [command, ...rest] = process.argv.slice(2);
if (command === "--help" || command === "-h") {
  console.log(USAGE);
  process.exit(0);
}
if (command !== "start" && command !== "report") {
  console.error(`${command ? `Unknown command: ${command}` : "No command given."}\n\n${USAGE}`);
  process.exit(2);
}

const args = parseArgs({ usage: USAGE, flags: ["--json"], values: ["--base", "--result", "--details", "--caller"], ids: true }, rest);
const fail = (message: string): never => {
  console.error(`${message}\n\n${USAGE}`);
  process.exit(2);
};
if (args.ids.length !== 1) fail("Exactly one story ID is needed – a worker builds the story it is given, it never picks one.");
const base = args.values.get("--base") ?? fail("--base <branch> is needed – a worker never assumes the default branch.");
const id = args.ids[0].toUpperCase();
const caller = args.values.get("--caller") || null;
const now = (): string => (process.env.KATASTER_MARATHON_NOW ? new Date(process.env.KATASTER_MARATHON_NOW) : new Date()).toISOString();

/** The claim of this story in the running marathon run, or null outside a run (a worker started by hand). */
function marathonClaim(): { run: string; claim: e.MarathonClaim } | null {
  try {
    const state = e.readMarathonState();
    const claim = state?.status === "running" ? state.claims[id] : undefined;
    return state && claim ? { run: state.run, claim } : null;
  } catch {
    return null; // a broken state is marathon-state.ts's to report
  }
}

if (command === "start") {
  let facts = w.workerFacts(id, base);
  const plan = w.planStart(facts);
  const inRun = marathonClaim();
  const gone = inRun ? isSuperseded(readLease(), caller) : null;
  if (gone) plan.problems.push(`this session was replaced as a ${gone.role} of the run at ${gone.at} – it builds nothing any more`);
  if (!plan.problems.length && plan.switch.length) {
    if (gitRaw(ROOT, plan.switch) === null) plan.problems.push(`'git ${plan.switch.join(" ")}' failed – run it by hand to see why`);
    else facts = w.workerFacts(id, base);
  }
  const ok = !plan.problems.length;
  if (args.flags.has("--json")) {
    console.log(JSON.stringify({ ok, pass: plan.pass, problems: plan.problems, ...facts }, null, 2));
    process.exit(ok ? 0 : 1);
  }
  if (!ok) {
    for (const p of plan.problems) console.log(`STOP         ${p}`);
    console.log("NEXT         report `blocked` with this reason – nothing was switched or changed");
    process.exit(1);
  }
  if (inRun && caller) {
    // The newest worker of a claim wins; the one before it is blocked by hooks/marathon-guard.ts from now on.
    let replaced: { caller: string; pass: number } | null = null;
    updateLease((l) => {
      const taken = takeWorker(l, inRun.run, id, inRun.claim.attempts, caller, now());
      replaced = taken.replaced;
      return taken.lease;
    });
    const r = replaced as { caller: string; pass: number } | null;
    console.log(`LEASE        worker of ${id}, pass ${inRun.claim.attempts}${r ? ` – replaces ${r.caller} (pass ${r.pass}); its tool calls are blocked from now on` : ""}`);
  }
  console.log(`PASS         ${plan.pass}`);
  console.log(`STORY        ${facts.story} – ${facts.title ?? "?"} [${facts.type ?? "?"}, ${facts.storyStatus ?? "?"}]`);
  console.log(
    plan.pass === "first"
      ? `BRANCH       ${facts.branch} – created from ${facts.base} @ ${facts.baseCommit}`
      : `BRANCH       ${facts.branch} @ ${facts.head} – ${facts.commits.length} commit(s) since ${facts.base}`,
  );
  if (plan.pass === "continuation") {
    console.log(`VERIFY       ${facts.verify.status}${facts.verify.failed.length ? ` (${facts.verify.failed.join(", ")})` : ""}`);
    console.log(`REVIEWS      ${facts.reviews.length ? facts.reviews.join(", ") : "none in docs/reviews/"}`);
  }
  const metrics = facts.uncommitted.length;
  if (metrics) console.log(`METRICS      ${metrics} collected file(s) uncommitted – commit them first as 'metrics: collect'`);
  process.exit(0);
}

// ---- report ---------------------------------------------------------------
const result = (args.values.get("--result") ?? fail("--result is needed.")) as w.WorkerResult;
if (!w.WORKER_RESULTS.includes(result)) fail(`--result must be one of ${w.WORKER_RESULTS.join(", ")}.`);

let raw: unknown;
const source = args.values.get("--details");
if (source !== undefined) {
  try {
    raw = JSON.parse(readFileSync(source === "-" ? 0 : source, "utf8"));
  } catch (err) {
    console.error(`The details are not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
}
const { details, errors } = w.parseDetails(raw);
if (errors.length) {
  console.error(`The details are incomplete:\n${errors.map((x) => `  - ${x}`).join("\n")}`);
  process.exit(2);
}

const inRun = marathonClaim();
const notTheWorker = inRun ? workerError(readLease(), inRun.run, id, caller) : null;
if (notTheWorker) {
  console.error(`${id}: no report – ${notTheWorker}`);
  process.exit(1);
}
const facts = w.workerFacts(id, base);
const errs = w.reportErrors(facts, result, details);
if (errs.length) {
  console.error(
    `${id} is not '${result}':\n${errs.map((x) => `  - ${x}`).join("\n")}\n\n` +
      "Fix what is named and run the report again – or report `blocked` with the reason. `blocked` is a result, not a failure.",
  );
  process.exit(1);
}
const report = w.buildReport(facts, result, details);
// Kept for the run: when the orchestrator is cut off before it reads this, a resumed one reads it from here.
if (inRun) keepReport({ run: inRun.run, story: id, pass: inRun.claim.attempts, caller, at: now(), head: facts.head, result, report });
console.log("```json");
console.log(JSON.stringify(report, null, 2));
console.log("```");
