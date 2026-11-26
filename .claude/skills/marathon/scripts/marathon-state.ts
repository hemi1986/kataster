/**
 * The only writer of .claude/state/marathon.json – the state of a marathon run. Every write happens under a lock
 * file and replaces the state atomically (temp file + rename); a stale lock is broken with a warning, a broken
 * state file is an error and is never overwritten.
 *
 *   start-run [--base <branch>] [--max-stories 6] [--max-failures 3] [--no-gate-foundation]
 *             [--budget-tokens <n>] [--budget-usd <n>]
 *       Starts a run: names it after the day, cuts the integration branch `marathon/<date>` from the base (the
 *       default branch) and writes the state. Refuses while an earlier run is not finished.
 *   claim ST-NNN [--continue]
 *       Takes the planned story for a worker. `--continue` starts a further pass on a story that is claimed already.
 *       Exit 3 = the run has to stop (limit, budget, red verify, foundation gate, nothing planned).
 *   review ST-NNN <agent> --verdict <verdict> [--blocker n] [--major n] [--minor n] [--question n]
 *       Records a review on the claim and in the story metrics, and prints what follows: fixes, merge or escalate.
 *   result ST-NNN merged|failed [--reason <text>] [--details <file>|-]
 *       Ends the claim. `merged` is checked against git and the last verify.ts run.
 *   escalate ST-NNN --reason <text> [--details <file>|-]
 *       Gives the story up for this run: it waits for the user.
 *   release ST-NNN
 *       Gives a claim back as if it had not been taken.
 *   resume [--running ST-NNN]
 *       Goes on with a run that was cut off: every claim without a running worker is orphaned – continued when its
 *       story branch exists (the pass counts), released when it does not.
 *   finish [--reason <text>] [--pr <url>]
 *       Ends the run; called again with --pr once the pull request is open.
 *   status [--json]      read-only: the run, its limits and the next step
 *   summary [--out <file>]  read-only: the run as Markdown – the body of its pull request
 *
 * Exit codes: 0 done · 1 refused (the message says what to fix) · 2 usage · 3 the run has to stop.
 * Harness-neutral: Claude Code and OpenCode run the same commands against the same file.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { parseArgs } from "../../../lib/args.ts";
import * as d from "../../../lib/discovery.ts";
import * as e from "../../../lib/engineering.ts";
import { gitRaw } from "../../../lib/git.ts";
import * as m from "../../../lib/marathon.ts";
import type { ReviewVerdict } from "../../../lib/metrics.ts";
import { appendReview, REVIEW_VERDICTS } from "../../../lib/metrics.ts";
import { storyBranch, workerFacts } from "../../../lib/worker.ts";

const SCRIPT = "node .claude/skills/marathon/scripts/marathon-state.ts";
const USAGE = `Usage:
  ${SCRIPT} start-run [--base <branch>] [--max-stories <n>] [--max-failures <n>] [--no-gate-foundation] [--budget-tokens <n>] [--budget-usd <n>]
  ${SCRIPT} claim ST-NNN [--continue]
  ${SCRIPT} review ST-NNN <agent> --verdict <verdict> [--blocker <n>] [--major <n>] [--minor <n>] [--question <n>]
  ${SCRIPT} result ST-NNN merged|failed [--reason <text>] [--details <file>|-]
  ${SCRIPT} escalate ST-NNN --reason <text> [--details <file>|-]
  ${SCRIPT} release ST-NNN
  ${SCRIPT} resume [--running ST-NNN]
  ${SCRIPT} finish [--reason <text>] [--pr <url>]
  ${SCRIPT} status [--json]
  ${SCRIPT} summary [--out <file>]

  --base <branch>        the branch the run is cut from (default: repo.defaultBranch in .claude/project.json)
  --max-stories <n>      stories the run may start (default ${m.DEFAULT_LIMITS.maxStories})
  --max-failures <n>     stories in a row that may end without a merge (default ${m.DEFAULT_LIMITS.maxFailures})
  --no-gate-foundation   do not stop after the foundation tasks (type: ${m.FOUNDATION_TYPE}); the gate is on by default
  --budget-tokens <n>    tokens the run's stories may use, from the story metrics (k and M are understood: 800k, 2.5M)
  --budget-usd <n>       cost the run's stories may reach, priced from metrics.prices
  --verdict <verdict>    ${REVIEW_VERDICTS.join(" | ")}
  --details <file>       JSON for the summary: { "openQuestions": [{ "question": "…", "kind": "domain|technical" }],
                         "notes": ["…"] } – or a worker report as it is; '-' reads stdin
  --running ST-NNN       resume: the worker of this claim is still running – keep the claim as it is

Exit codes: 0 done · 1 refused · 2 usage · 3 the run has to stop (go on with the end of the run).`;

const [command, ...rest] = process.argv.slice(2);
if (command === "--help" || command === "-h") {
  console.log(USAGE);
  process.exit(0);
}
const COMMANDS = ["start-run", "claim", "review", "result", "escalate", "release", "resume", "finish", "status", "summary"];
if (!command || !COMMANDS.includes(command)) {
  console.error(`${command ? `Unknown command: ${command}` : "No command given."}\n\n${USAGE}`);
  process.exit(2);
}

const usage = (message: string): never => {
  console.error(`${message}\n\n${USAGE}`);
  process.exit(2);
};
const refuse = (message: string): never => {
  console.error(message);
  process.exit(1);
};

// Positional words (an outcome, a reviewer) are taken out before the strict parser sees the rest.
const words: string[] = [];
const VALUE_OPTIONS = ["--base", "--max-stories", "--max-failures", "--budget-tokens", "--budget-usd", "--verdict", "--blocker", "--major", "--minor", "--question", "--reason", "--details", "--running", "--pr", "--out"];
const argv: string[] = [];
for (let i = 0; i < rest.length; i += 1) {
  const arg = rest[i];
  if (VALUE_OPTIONS.includes(arg)) argv.push(arg, rest[++i] ?? "");
  else if (arg.startsWith("-") || /^ST-\d+$/i.test(arg)) argv.push(arg);
  else words.push(arg);
}
// `--running ST-NNN` takes a story ID as its value; everything else that looks like one is the story.
const args = parseArgs({ usage: USAGE, flags: ["--continue", "--json", "--no-gate-foundation", "--gate-foundation"], values: VALUE_OPTIONS, ids: true }, argv);

const STATE = e.MARATHON_STATE_FILE;
// KATASTER_MARATHON_NOW pins the clock – for tests only.
const now = (): Date => (process.env.KATASTER_MARATHON_NOW ? new Date(process.env.KATASTER_MARATHON_NOW) : new Date());
const iso = (): string => now().toISOString();

function storyArg(): string {
  if (args.ids.length !== 1) usage(`${command} needs exactly one story ID.`);
  return args.ids[0].toUpperCase();
}
function noStory(): void {
  if (args.ids.length) usage(`${command} takes no story ID.`);
}
function noWords(max = 0): void {
  if (words.length > max) usage(`Unknown argument: ${words[max]}`);
}

function count(name: string, fallback: number, min = 0): number {
  const raw = args.values.get(name);
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) < min) usage(`${name} needs a whole number ≥ ${min}, got '${raw}'.`);
  return Number(raw);
}
function amount(name: string): number | null {
  const raw = args.values.get(name);
  if (raw === undefined) return null;
  const match = /^(\d+(?:\.\d+)?)([kKmM]?)$/.exec(raw);
  const value = match ? Number(match[1]) * (match[2] ? (match[2].toLowerCase() === "k" ? 1e3 : 1e6) : 1) : NaN;
  if (!(value > 0)) usage(`${name} needs a number > 0, got '${raw}'.`);
  return value;
}

function readDetails(): m.Details {
  const source = args.values.get("--details");
  if (source === undefined) return { openQuestions: [], notes: [] };
  let raw: unknown;
  try {
    // A worker hands its report over as a fenced block – the fence is not part of the JSON.
    const text = readFileSync(source === "-" ? 0 : source, "utf8").trim().replace(/^```(?:json)?\s*\n/, "").replace(/\n```$/, "");
    raw = JSON.parse(text);
  } catch (err) {
    console.error(`The details are not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
  const { details, errors } = m.parseDetails(raw);
  if (errors.length) {
    console.error(`The details are incomplete:\n${errors.map((x) => `  - ${x}`).join("\n")}`);
    process.exit(2);
  }
  return details;
}

/** The state as it is on disk; a broken file ends the command – nothing is planned or written from a guess. */
function load(): e.MarathonState | null {
  try {
    return e.readMarathonState(STATE);
  } catch (err) {
    throw new m.MarathonError(
      `${err instanceof Error ? err.message : String(err)}\n\nThe state is never overwritten while it is broken: repair ${d.rel(STATE)} by hand ` +
        "(git and the story branches are the facts), or move it away to give the run up.",
    );
  }
}
function loaded(): e.MarathonState {
  const state = load();
  if (!state) throw new m.MarathonError(`No marathon run: ${d.rel(STATE)} does not exist – \`${SCRIPT} start-run\` starts one.`);
  return state;
}

/** Reads, changes and writes the state under the lock. `change` may be async: it reads facts before it decides. */
async function update<T>(change: (state: e.MarathonState) => Promise<{ state: e.MarathonState; out: T }> | { state: e.MarathonState; out: T }): Promise<T> {
  const release = m.acquireLock(STATE);
  try {
    const { state, out } = await change(loaded());
    m.writeMarathonState(state, STATE);
    return out;
  } finally {
    release();
  }
}

const say = (label: string, text: string): void => console.log(`${label.padEnd(12)} ${text}`);

async function plan(state: e.MarathonState): Promise<{ plan: e.WavePlan; facts: m.StopFacts }> {
  const wave = e.planWave(e.storiesById(), state, 1);
  return { plan: wave, facts: await m.stopFacts(state, wave) };
}

function fail(err: unknown): never {
  if (err instanceof m.MarathonStop) {
    say("STOP", `${err.message} – end the run`);
    process.exit(3);
  }
  if (err instanceof m.MarathonError) return refuse(err.message);
  throw err;
}

try {
  // ---- start-run ------------------------------------------------------------
  if (command === "start-run") {
    noStory();
    noWords();
    const release = m.acquireLock(STATE);
    try {
      const existing = load();
      if (existing?.status === "running") {
        throw new m.MarathonError(`Run ${existing.run} (${existing.integrationBranch}) is not finished – \`${SCRIPT} resume\` goes on with it, \`${SCRIPT} finish --reason …\` ends it.`);
      }
      const base = args.values.get("--base") ?? m.defaultBranch();
      if (gitRaw(d.ROOT, ["rev-parse", "--verify", "--quiet", `${base}^{commit}`]) === null) throw new m.MarathonError(`The base '${base}' does not exist in this checkout.`);
      const dirty = m.dirtyPaths();
      if (dirty.length) throw new m.MarathonError(`The working tree has uncommitted changes (${dirty.slice(0, 5).join(", ")}${dirty.length > 5 ? ", …" : ""}) – a run starts from a clean tree.`);
      const stories = e.storiesById();
      const wave = e.planWave(stories, null, 1);
      if (!wave.wave.length) throw new m.MarathonError(`Nothing to run: ${wave.reason}. No branch was created.`);

      const { run, branch } = m.runName(now(), (b) => m.branchExists(b) || b === existing?.integrationBranch || existsSync(m.archiveFile(b.replace(/^marathon\//, ""), STATE)));
      const state = m.newRun({
        run,
        branch,
        base,
        now: iso(),
        limits: {
          maxStories: count("--max-stories", m.DEFAULT_LIMITS.maxStories, 1),
          maxFailures: count("--max-failures", m.DEFAULT_LIMITS.maxFailures, 1),
          gateFoundation: !args.flags.has("--no-gate-foundation"),
          budgetTokens: amount("--budget-tokens"),
          budgetUsd: amount("--budget-usd"),
        },
      });
      if (gitRaw(d.ROOT, ["switch", "-c", branch, base]) === null) throw new m.MarathonError(`'git switch -c ${branch} ${base}' failed – run it by hand to see why. No run was started.`);
      if (existing) {
        const archive = m.archiveFile(existing.run, STATE);
        mkdirSync(dirname(archive), { recursive: true });
        renameSync(STATE, archive);
        say("ARCHIVED", `run ${existing.run} → ${d.rel(archive)}`);
      }
      m.writeMarathonState(state, STATE);
      const l = state.limits;
      say("RUN", `${run} → ${branch} (from ${base})`);
      say(
        "LIMITS",
        `${l.maxStories} stories, ${l.maxFailures} failures in a row, foundation gate ${l.gateFoundation ? "on" : "off"}` +
          `${l.budgetTokens !== null ? `, ${l.budgetTokens} tokens` : ""}${l.budgetUsd !== null ? `, $${l.budgetUsd.toFixed(2)}` : ""}`,
      );
      say("NEXT", `${d.storyId(wave.wave[0].story)} – ${wave.wave[0].story.meta.title}`);
    } finally {
      release();
    }
    process.exit(0);
  }

  // ---- claim ----------------------------------------------------------------
  if (command === "claim") {
    noWords();
    const id = storyArg();
    const out = await update(async (state) => {
      if (args.flags.has("--continue")) {
        const claim = state.claims[id];
        if (claim && !m.branchExists(claim.branch)) throw new m.MarathonError(`The story branch '${claim.branch}' does not exist – there is nothing to continue: \`${SCRIPT} release ${id}\``);
        const next = m.applyContinue(state, id, iso());
        return { state: next, out: `${id} on ${next.claims[id].branch} – pass ${next.claims[id].attempts} (continuation)` };
      }
      m.assertClaimable(state, id);
      const current = m.currentBranch();
      if (current !== state.integrationBranch) throw new m.MarathonError(`The checkout is on '${current ?? "?"}' – a story is claimed on the integration branch '${state.integrationBranch}', where its branch is cut.`);
      const dirty = m.dirtyPaths();
      if (dirty.length) throw new m.MarathonError(`The working tree has uncommitted changes (${dirty.slice(0, 5).join(", ")}${dirty.length > 5 ? ", …" : ""}) – commit the bookkeeping of the last story first.`);
      const { plan: wave, facts } = await plan(state);
      const stop = m.stopReason(state, facts);
      if (stop) throw new m.MarathonStop(stop);
      const planned = wave.wave[0].story;
      if (d.storyId(planned) !== id) throw new m.MarathonError(`${id} is not the planned story – marathon-plan.ts says ${d.storyId(planned)}.`);
      const next = m.applyClaim(state, { id, branch: storyBranch(planned.path), type: String(planned.meta.type ?? "") }, iso());
      return { state: next, out: `${id} on ${next.claims[id].branch} – pass ${next.claims[id].attempts}` };
    });
    say("CLAIMED", out);
    process.exit(0);
  }

  // ---- review ---------------------------------------------------------------
  if (command === "review") {
    const id = storyArg();
    noWords(1);
    const agent = words[0] ?? usage("review needs the reviewer: review ST-NNN <agent> --verdict <verdict>.");
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(agent)) usage(`'${agent}' is not an agent name.`);
    const verdict = (args.values.get("--verdict") ?? usage("--verdict is needed.")) as ReviewVerdict;
    if (!REVIEW_VERDICTS.includes(verdict)) usage(`--verdict must be one of ${REVIEW_VERDICTS.join(", ")}.`);
    const review = { agent, verdict, blocker: count("--blocker", 0), major: count("--major", 0), minor: count("--minor", 0), question: count("--question", 0) };
    const at = iso();
    const next = await update((state) => {
      const applied = m.applyReview(state, id, review, at);
      return { state: applied.state, out: applied.next };
    });
    // The story metrics get the same record; a failure there never blocks the run.
    try {
      appendReview(d.ROOT, id, { ...review, at });
    } catch (err) {
      console.error(`⚠ the review was not written to docs/stories/metrics/${id}.json: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (args.flags.has("--json")) {
      console.log(JSON.stringify({ story: id, review: { ...review, at }, next }, null, 2));
      process.exit(0);
    }
    say("REVIEW", `${id} ${agent}: ${verdict.replaceAll("-", " ")} – ${review.blocker} blocker, ${review.major} major, ${review.minor} minor, ${review.question} question`);
    const r = next.round;
    if (next.action === "escalate") say("NEXT", `escalate – 'not accepted' ${next.notAccepted} times: ${SCRIPT} escalate ${id} --reason "…"`);
    else if (next.action === "fixes") {
      say("NEXT", `fixes – a worker pass with the findings (${r.blocker} blocker, ${r.major} major this round): ${SCRIPT} claim ${id} --continue`);
      say("THEN", next.then === "acceptance" ? "the acceptance-tester again – its verdict was 'not accepted'" : "the merge – the acceptance stands, no second review");
    } else say("NEXT", `merge – nothing a worker has to fix${r.minor + r.question ? ` (${r.minor} minor, ${r.question} question are yours to decide)` : ""}`);
    process.exit(0);
  }

  // ---- result ---------------------------------------------------------------
  if (command === "result") {
    const id = storyArg();
    noWords(1);
    const outcome = words[0];
    if (outcome !== "merged" && outcome !== "failed") usage("result needs an outcome: merged or failed.");
    const details = readDetails();
    const reason = args.values.get("--reason");
    if (outcome === "failed" && !reason) usage("result … failed needs --reason: what ended the pass.");
    const out = await update((state) => {
      if (outcome === "failed") {
        const applied = m.applyFailed(state, id, reason!, details, iso());
        return { state: applied.state, out: applied.escalated ? `${id} failed again and is escalated – it waits for the user` : `${id} failed – it may be planned once more` };
      }
      const claim = state.claims[id];
      if (claim) {
        const errs = m.mergeErrors(state, id, claim, m.mergeFacts(state, claim, workerFacts(id, state.integrationBranch).storyStatus));
        if (errs.length) throw new m.MarathonError(`${id} is not merged:\n${errs.map((x) => `  - ${x}`).join("\n")}`);
      }
      return { state: m.applyMerged(state, id, details, iso()), out: `${id} merged into ${state.integrationBranch}` };
    });
    say("RESULT", out);
    process.exit(0);
  }

  // ---- escalate / release ---------------------------------------------------
  if (command === "escalate") {
    noWords();
    const id = storyArg();
    const reason = args.values.get("--reason") ?? usage("escalate needs --reason: what the user has to decide or repair.");
    const details = readDetails();
    const failures = await update((state) => {
      const next = m.applyEscalate(state, id, reason, details, iso(), !!state.claims[id] && m.branchExists(state.claims[id].branch));
      return { state: next, out: `${next.consecutiveFailures} of ${next.limits.maxFailures}` };
    });
    say("ESCALATED", `${id} – ${reason}`);
    say("FAILURES", `${failures} in a row`);
    process.exit(0);
  }

  if (command === "release") {
    noWords();
    const id = storyArg();
    await update((state) => ({ state: m.applyRelease(state, id), out: null }));
    say("RELEASED", `${id} – back in the plan`);
    process.exit(0);
  }

  // ---- resume ---------------------------------------------------------------
  if (command === "resume") {
    noWords();
    noStory();
    const runningWorkers = args.values.has("--running") ? [args.values.get("--running")!.toUpperCase()] : [];
    const state0 = loaded();
    if (state0.status === "finished") {
      say("RUN", `${state0.run} → ${state0.integrationBranch} – finished: ${state0.stop?.reason ?? ""}`);
      say("NEXT", state0.stop?.pr ? `nothing – the pull request is open: ${state0.stop.pr}` : "push the integration branch and open the pull request (the end of the run)");
      process.exit(0);
    }
    if (!m.branchExists(state0.integrationBranch)) refuse(`The integration branch '${state0.integrationBranch}' of run ${state0.run} does not exist in this checkout – fetch it, or end the run with \`${SCRIPT} finish --reason …\`.`);
    const actions = await update((state) => {
      const facts = Object.fromEntries(Object.keys(state.claims).map((id) => [id, m.claimFacts(workerFacts(id, state.integrationBranch))]));
      const applied = m.applyResume(state, facts, runningWorkers, iso());
      return { state: applied.state, out: applied.actions };
    });
    const state = loaded();
    say("RUN", `${state.run} → ${state.integrationBranch} (from ${state.base})`);
    const current = m.currentBranch();
    const dirty = m.dirtyPaths();
    say("CHECKOUT", `${current ?? "?"}${dirty.length ? ` – ${dirty.length} uncommitted path(s): ${dirty.slice(0, 5).join(", ")}${dirty.length > 5 ? ", …" : ""}` : ", clean"}`);
    for (const a of actions) {
      if (a.action === "keep") say("RUNNING", `${a.story} on ${a.branch} – its worker is still at work; wait for the report`);
      if (a.action === "release") say("RELEASED", `${a.story} – orphaned claim without the branch ${a.branch}; back in the plan`);
      if (a.action === "continue") say("CONTINUE", `${a.story} on ${a.branch} – orphaned claim; start a story-worker continuation (pass ${a.attempts})`);
      if (a.action === "merge") say("MERGE", `${a.story} on ${a.branch} – accepted or merged already; go on with the merge step, skipping what is done`);
    }
    if (!actions.length) say("CLAIMS", "none open");
    const { facts } = await plan(state);
    const next = m.nextStep(state, facts);
    if (next.action === "claim") say("NEXT", `${next.story} – plan and claim it`);
    if (next.action === "stop") say("STOP", `${next.reason} – end the run`);
    process.exit(0);
  }

  // ---- finish ---------------------------------------------------------------
  if (command === "finish") {
    noWords();
    noStory();
    const out = await update(async (state) => {
      let reason = args.values.get("--reason");
      if (!reason && state.status === "running" && !Object.keys(state.claims).length) reason = m.stopReason(state, (await plan(state)).facts) ?? undefined;
      const next = m.applyFinish(state, { reason, pr: args.values.get("--pr") }, iso());
      return { state: next, out: next };
    });
    say("FINISHED", `${out.run} – ${out.stop!.reason}`);
    say(out.stop!.pr ? "PR" : "NEXT", out.stop!.pr ?? `push ${out.integrationBranch}, open the pull request, then \`${SCRIPT} finish --pr <url>\``);
    process.exit(0);
  }

  // ---- status / summary (read-only) -----------------------------------------
  const state = loaded();
  // The usage needs the tooling dependencies and readable metrics; a run can be looked at without them.
  const used = await m.runUsage(state).catch(() => null);

  if (command === "status") {
    noWords();
    noStory();
    const { facts } = state.status === "running" ? await plan(state) : { facts: { next: null, planReason: null, verify: null, usage: null } };
    const next = m.nextStep(state, { ...facts, usage: facts.usage ?? (state.limits.budgetTokens !== null || state.limits.budgetUsd !== null ? used : null) });
    const counts = m.runCounts(state);
    if (args.flags.has("--json")) {
      console.log(
        JSON.stringify(
          {
            stateFile: d.rel(STATE),
            run: state.run,
            status: state.status,
            integrationBranch: state.integrationBranch,
            base: state.base,
            startedAt: state.startedAt,
            limits: state.limits,
            counts,
            consecutiveFailures: state.consecutiveFailures,
            usage: used ? { tokens: used.tokens, costUsd: used.costUsd, unpriced: used.unpriced } : null,
            claims: state.claims,
            escalations: state.escalations,
            stop: state.stop ?? null,
            next,
          },
          null,
          2,
        ),
      );
      process.exit(0);
    }
    const l = state.limits;
    say("RUN", `${state.run} → ${state.integrationBranch} (from ${state.base}) – ${state.status}`);
    say("STORIES", `${counts.started} of ${l.maxStories} started: ${counts.merged} merged, ${counts.escalated} escalated, ${counts.failed} failed`);
    say("FAILURES", `${state.consecutiveFailures} of ${l.maxFailures} in a row · foundation gate ${l.gateFoundation ? "on" : "off"}`);
    if (used) {
      say(
        "USAGE",
        `${Math.round(used.tokens)} tokens${l.budgetTokens !== null ? ` of ${l.budgetTokens}` : ""} · ` +
          `${used.costUsd === null ? "cost unknown" : `$${used.costUsd.toFixed(2)}`}${l.budgetUsd !== null ? ` of $${l.budgetUsd.toFixed(2)}` : ""}`,
      );
    }
    for (const [id, c] of Object.entries(state.claims)) say("CLAIMED", `${id} on ${c.branch} – pass ${c.attempts}, ${c.phase ?? "worker"}, ${(c.reviews ?? []).length} review(s)`);
    for (const x of state.escalations) say("ESCALATED", `${x.story} – ${x.reason}`);
    if (next.action === "claim") say("NEXT", `${next.story} – claim it`);
    if (next.action === "work") say("NEXT", `${next.story} – go on in its ${next.phase} step on ${next.branch}`);
    if (next.action === "stop") say("STOP", `${next.reason} – end the run`);
    if (next.action === "open-pr") say("NEXT", `push ${state.integrationBranch} and open the pull request – the run ended: ${next.reason}`);
    if (next.action === "none") say("DONE", next.reason);
    process.exit(0);
  }

  // summary
  noWords();
  noStory();
  const titles = new Map([...e.storiesById()].map(([id, s]) => [id, String(s.meta.title ?? "")]));
  let metrics = "No metrics were collected for the stories of this run.";
  if (used?.report.stories.length) {
    const { storiesTable } = await import("../../../lib/metrics-report.ts");
    const total = `**Run:** ${Math.round(used.tokens)} tokens · ${used.costUsd === null ? "cost unknown" : `$${used.costUsd.toFixed(2)}`} (own phases and unassigned, without spec share)`;
    metrics = [storiesTable(used.report.stories), "", total, ...used.report.warnings.map((w) => `- ⚠ ${w}`)].join("\n");
  }
  const text = m.renderSummary(state, titles, metrics);
  const target = args.values.get("--out");
  if (target) {
    const file = isAbsolute(target) ? target : join(d.ROOT, target);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${text}\n`, "utf8");
    say("WRITTEN", d.rel(file));
  } else console.log(text);
  process.exit(0);
} catch (err) {
  fail(err);
}
