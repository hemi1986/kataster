import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { marathonStateErrors } from "../.claude/lib/engineering.ts";
import {
  acquireLock, applyClaim, applyContinue, applyEscalate, applyFailed, applyFinish, applyMerged, applyRelease, applyResume, applyReview, claimFacts,
  MarathonError, mergeErrors, newRun, nextStep, orphanAction, parseDetails, renderSummary, reviewNext, runCounts, runName, stopReason,
  withStateLock, writeMarathonState,
} from "../.claude/lib/marathon.ts";
import { parseJsonc } from "../src/util.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const cli = resolve(root, "bin", "kataster.mjs");
const yamlSource = resolve(root, ".claude", "node_modules", "yaml");

const T0 = "2026-11-26T12:00:00.000Z";
const T1 = "2026-11-26T12:30:00.000Z";
const T2 = "2026-11-26T13:00:00.000Z";
const BRANCH = "marathon/2026-11-26";

// --------------------------------------------------------------------------
// The decisions – pure, no repository and no agent
// --------------------------------------------------------------------------
const run = (limits = {}) => newRun({ run: "2026-11-26", branch: BRANCH, base: "main", now: T0, limits });
const claimed = (state, id = "ST-001", type = "chore", at = T0) => applyClaim(state, { id, branch: `${id.toLowerCase()}-demo`, type }, at);
const none = { openQuestions: [], decisions: [], notes: [] };
const facts = (over = {}) => ({ next: { id: "ST-009", type: "chore" }, planReason: null, verify: null, usage: null, ...over });
const review = (agent, verdict, counts = {}) => ({ agent, verdict, blocker: 0, major: 0, minor: 0, question: 0, ...counts });

test("newRun: a valid state with the default limits", () => {
  const state = run();
  assert.deepEqual(marathonStateErrors(state), []);
  assert.deepEqual(state.limits, { maxStories: 6, maxFailures: 3, gateFoundation: true, budgetTokens: null, budgetUsd: null });
  assert.equal(state.status, "running");
});

test("runName: the day names the run; a second run of the day gets a suffix", () => {
  const noon = new Date(2026, 10, 26, 12, 0, 0);
  assert.deepEqual(runName(noon, () => false), { run: "2026-11-26", branch: "marathon/2026-11-26" });
  const taken = new Set(["marathon/2026-11-26", "marathon/2026-11-26-2"]);
  assert.deepEqual(runName(noon, (b) => taken.has(b)), { run: "2026-11-26-3", branch: "marathon/2026-11-26-3" });
});

test("claim: serial – one story at a time; a retry keeps counting its passes", () => {
  const state = claimed(run());
  assert.deepEqual(state.claims["ST-001"], { branch: "st-001-demo", start: T0, attempts: 1, type: "chore", phase: "worker", passStart: T0, reviews: [] });
  assert.throws(() => claimed(state, "ST-002"), /ST-001 is still claimed – a serial run holds one story at a time/);
  assert.throws(() => claimed(state, "ST-001"), /claim ST-001 --continue/);

  const again = applyContinue(state, "ST-001", T1);
  assert.equal(again.claims["ST-001"].attempts, 2);
  assert.equal(again.claims["ST-001"].passStart, T1);
  assert.throws(() => applyContinue(state, "ST-002", T1), /ST-002 is not claimed \(open claim: ST-001\)/);

  const failed = applyFailed(again, "ST-001", "no report", none, T1).state;
  assert.equal(claimed(failed, "ST-001", "chore", T2).claims["ST-001"].attempts, 3, "the retry counts on from the failed pass");

  const released = applyRelease(state, "ST-001");
  assert.deepEqual(released.claims, {});
  assert.deepEqual(released.results, {}, "a released claim leaves no trace");
  assert.equal(claimed(released).claims["ST-001"].attempts, 1);
});

test("results: a merge resets the failures in a row, escalations and failed passes add to them", () => {
  let state = applyEscalate(claimed(run()), "ST-001", "blocked: no seam for the mailer", { openQuestions: [{ question: "Which seam?", kind: "technical" }], notes: [] }, T1);
  assert.equal(state.consecutiveFailures, 1);
  assert.deepEqual(state.claims, {});
  assert.equal(state.escalations[0].branch, "st-001-demo");
  assert.deepEqual(state.escalations[0].openQuestions, [{ question: "Which seam?", kind: "technical" }]);

  state = applyFailed(claimed(state, "ST-002"), "ST-002", "the worker returned no report", none, T1).state;
  assert.equal(state.consecutiveFailures, 2);
  assert.equal(state.results["ST-002"].outcome, "failed");

  state = applyMerged(claimed(state, "ST-003"), "ST-003", { openQuestions: [], notes: ["ADR 0007 proposed"] }, T2);
  assert.equal(state.consecutiveFailures, 0);
  assert.deepEqual(state.results["ST-003"], { outcome: "merged", at: T2, branch: "st-003-demo", attempts: 1, type: "chore", notes: ["ADR 0007 proposed"] });
  assert.deepEqual(runCounts(state), { started: 3, merged: 1, failed: 1, escalated: 1, claimed: 0 });
  assert.deepEqual(marathonStateErrors(state), []);
});

test("a story that fails twice is escalated instead of planned a third time", () => {
  const once = applyFailed(claimed(run()), "ST-001", "no report", none, T1);
  assert.equal(once.escalated, false);
  assert.deepEqual(once.state.escalations, []);
  const twice = applyFailed(claimed(once.state), "ST-001", "no report again", none, T2);
  assert.equal(twice.escalated, true);
  assert.match(twice.state.escalations[0].reason, /failed 2 times – last: no report again/);
  assert.equal(twice.state.consecutiveFailures, 2);
  assert.deepEqual(runCounts(twice.state), { started: 1, merged: 0, failed: 0, escalated: 1, claimed: 0 });
});

test("stopReason: nothing stops a fresh run; an empty plan does", () => {
  assert.equal(stopReason(run(), facts()), null);
  assert.equal(stopReason(run(), facts({ next: null, planReason: "no story is ready" })), "no story is ready");
});

test("stopReason: a red verify on the integration branch stops the run – on a story branch it does not", () => {
  const red = { ok: false, steps: [{ name: "lint", ok: true }, { name: "test", ok: false }] };
  assert.match(stopReason(run(), facts({ verify: { branch: BRANCH, ...red } })), /verify is red on marathon\/2026-11-26 \(test\)/);
  assert.equal(stopReason(run(), facts({ verify: { branch: "st-001-demo", ...red } })), null);
  assert.equal(stopReason(run(), facts({ verify: { branch: BRANCH, ok: true, steps: [] } })), null);
});

test("stopReason: the failures in a row and the story limit", () => {
  let state = run({ maxFailures: 2, maxStories: 3 });
  state = applyEscalate(claimed(state, "ST-001"), "ST-001", "blocked", none, T1);
  assert.equal(stopReason(state, facts()), null);
  state = applyEscalate(claimed(state, "ST-002"), "ST-002", "blocked", none, T1);
  assert.equal(stopReason(state, facts()), "2 stories in a row ended without a merge (limit 2)");

  let full = run({ maxStories: 2 });
  full = applyMerged(claimed(full, "ST-001"), "ST-001", none, T1);
  full = applyFailed(claimed(full, "ST-002"), "ST-002", "no report", none, T1).state;
  assert.equal(stopReason(full, facts({ next: { id: "ST-003", type: "chore" } })), "the run has started 2 stories (limit 2)");
  assert.equal(stopReason(full, facts({ next: { id: "ST-002", type: "chore" } })), null, "the retry of a started story is no new story");
});

test("stopReason: the budget – tokens, cost, and a cost nobody can price", () => {
  const tokens = run({ budgetTokens: 1_000_000 });
  assert.equal(stopReason(tokens, facts({ usage: { tokens: 999_999, costUsd: null, unpriced: ["m"] } })), null);
  assert.equal(stopReason(tokens, facts({ usage: { tokens: 1_200_000, costUsd: null, unpriced: [] } })), "the token budget is used up: 1.20M of 1.00M");

  const usd = run({ budgetUsd: 20 });
  assert.equal(stopReason(usd, facts({ usage: { tokens: 5, costUsd: 19.99, unpriced: [] } })), null);
  assert.equal(stopReason(usd, facts({ usage: { tokens: 5, costUsd: 20.5, unpriced: [] } })), "the cost budget is used up: $20.50 of $20.00");
  assert.match(stopReason(usd, facts({ usage: { tokens: 5, costUsd: null, unpriced: ["acme/model-x"] } })), /cannot be checked: no price in metrics\.prices for acme\/model-x/);
});

test("stopReason: the foundation gate stops once a foundation task is merged and another kind of story is next", () => {
  let state = run();
  assert.equal(stopReason(state, facts({ next: { id: "ST-001", type: "tech-task" } })), null);
  state = applyMerged(claimed(state, "ST-001", "tech-task"), "ST-001", none, T1);
  assert.equal(stopReason(state, facts({ next: { id: "ST-002", type: "tech-task" } })), null, "the foundation is not through yet");
  assert.match(stopReason(state, facts({ next: { id: "ST-003", type: "domain" } })), /foundation gate: ST-001 merged and ST-003 is no foundation task/);

  const open = { ...state, limits: { ...state.limits, gateFoundation: false } };
  assert.equal(stopReason(open, facts({ next: { id: "ST-003", type: "domain" } })), null);
  // A run without foundation tasks never meets the gate.
  const plain = applyMerged(claimed(run(), "ST-001", "chore"), "ST-001", none, T1);
  assert.equal(stopReason(plain, facts({ next: { id: "ST-003", type: "domain" } })), null);
});

test("nextStep: the story in hand comes before every limit", () => {
  const state = claimed(run({ maxFailures: 1 }));
  assert.deepEqual(nextStep(state, facts()), { action: "work", story: "ST-001", phase: "worker", branch: "st-001-demo" });
  const escalated = applyEscalate(state, "ST-001", "blocked", none, T1);
  assert.deepEqual(nextStep(escalated, facts()), { action: "stop", reason: "1 story in a row ended without a merge (limit 1)" });
  assert.deepEqual(nextStep(run(), facts()), { action: "claim", story: "ST-009" });
  const finished = applyFinish(escalated, { reason: "limit" }, T2);
  assert.deepEqual(nextStep(finished, facts()), { action: "open-pr", reason: "limit" });
  assert.equal(nextStep(applyFinish(finished, { pr: "https://example.test/pr/1" }, T2), facts()).action, "none");
});

test("reviews: blockers send the worker back; the acceptance stands, so the merge follows the fixes", () => {
  let state = claimed(run());
  let r = applyReview(state, "ST-001", review("code-reviewer", "fix-blockers-first", { blocker: 1, minor: 2 }), T1);
  assert.deepEqual(r.next, { action: "fixes", then: "merge", notAccepted: 0, round: { blocker: 1, major: 0, minor: 2, question: 0 } });
  r = applyReview(r.state, "ST-001", review("acceptance-tester", "accepted-with-remarks", { minor: 1 }), T1);
  assert.equal(r.next.action, "fixes", "the round is judged as a whole – the code review still needs fixes");
  assert.equal(r.next.then, "merge");
  assert.equal(r.state.claims["ST-001"].phase, "review");
  assert.deepEqual(r.next.round, { blocker: 1, major: 0, minor: 3, question: 0 });

  // The fixes pass starts a new round: with nothing recorded in it, nothing is left to fix.
  state = applyContinue(r.state, "ST-001", T2);
  assert.equal(reviewNext(state.claims["ST-001"]).action, "merge");
  assert.equal(state.claims["ST-001"].reviews.length, 2, "earlier rounds stay on the claim");
});

test("reviews: 'not accepted' is fixed once and re-reviewed; the second one escalates", () => {
  let r = applyReview(claimed(run()), "ST-001", review("acceptance-tester", "not-accepted", { blocker: 2 }), T1);
  assert.deepEqual([r.next.action, r.next.then, r.next.notAccepted], ["fixes", "acceptance", 1]);

  const second = applyContinue(r.state, "ST-001", T2);
  const accepted = applyReview(second, "ST-001", review("acceptance-tester", "accepted"), T2);
  assert.equal(accepted.next.action, "merge");
  assert.equal(accepted.state.claims["ST-001"].phase, "merge");

  r = applyReview(second, "ST-001", review("acceptance-tester", "not-accepted", { blocker: 1 }), T2);
  assert.deepEqual([r.next.action, r.next.notAccepted], ["escalate", 2]);
  const escalated = applyEscalate(r.state, "ST-001", "not accepted twice: the reminder is never sent", none, T2);
  assert.equal(escalated.escalations[0].reviews.length, 2, "the reviews travel with the escalation");
});

test("reviews: a clean round goes to the merge; minors and questions are the orchestrator's call", () => {
  const r = applyReview(claimed(run()), "ST-001", review("acceptance-tester", "accepted-with-remarks", { minor: 2, question: 1 }), T1);
  assert.equal(r.next.action, "merge");
  assert.throws(() => applyReview(run(), "ST-001", review("acceptance-tester", "accepted"), T1), /ST-001 is not claimed/);
  assert.throws(() => applyReview(claimed(run()), "ST-001", review("acceptance-tester", "fine"), T1), /'fine' is not a verdict/);
});

test("orphaned claims: continued when the story branch exists, released when it does not", () => {
  const claim = claimed(run()).claims["ST-001"];
  assert.equal(orphanAction(claim, { branchExists: true, merged: false }, false), "continue");
  assert.equal(orphanAction(claim, { branchExists: false, merged: false }, false), "release");
  assert.equal(orphanAction(claim, { branchExists: true, merged: true }, false), "merge");
  assert.equal(orphanAction({ ...claim, phase: "merge" }, { branchExists: true, merged: false }, false), "merge");
  assert.equal(orphanAction(claim, { branchExists: true, merged: false }, true), "keep");
  assert.equal(orphanAction(claim, { branchExists: false, merged: false }, true), "keep", "a running worker has not created its branch yet");

  // What git says: a branch without commits of its own is merged only when the integration branch has the story started.
  assert.deepEqual(claimFacts({ branchExists: true, commits: [], baseStatus: "ready" }), { branchExists: true, merged: false });
  assert.deepEqual(claimFacts({ branchExists: true, commits: [], baseStatus: "in-progress" }), { branchExists: true, merged: true });
  assert.deepEqual(claimFacts({ branchExists: true, commits: [{ sha: "a", subject: "s" }], baseStatus: "ready" }), { branchExists: true, merged: false });
  assert.deepEqual(claimFacts({ branchExists: false, commits: [], baseStatus: "ready" }), { branchExists: false, merged: false });
});

test("resume: the continuation counts as a pass, the release does not, and a finished run is not resumed", () => {
  const state = claimed(run());
  const cont = applyResume(state, { "ST-001": { branchExists: true, merged: false } }, [], T1);
  assert.deepEqual(cont.actions, [{ story: "ST-001", action: "continue", branch: "st-001-demo", attempts: 2 }]);
  assert.equal(cont.state.claims["ST-001"].passStart, T1);

  const gone = applyResume(state, { "ST-001": { branchExists: false, merged: false } }, [], T1);
  assert.deepEqual(gone.actions, [{ story: "ST-001", action: "release", branch: "st-001-demo", attempts: 1 }]);
  assert.deepEqual(gone.state.claims, {});
  assert.deepEqual(gone.state.results, {});

  const kept = applyResume(state, { "ST-001": { branchExists: true, merged: false } }, ["ST-001"], T1);
  assert.equal(kept.actions[0].action, "keep");
  assert.deepEqual(kept.state, state);
  assert.throws(() => applyResume(state, {}, ["ST-007"], T1), /ST-007 is not claimed/);

  const merged = applyResume(state, { "ST-001": { branchExists: true, merged: true } }, [], T1);
  assert.equal(merged.state.claims["ST-001"].phase, "merge");
  assert.equal(merged.state.claims["ST-001"].attempts, 1);

  assert.deepEqual(applyResume(run(), {}, [], T1).actions, []);
  assert.throws(() => applyResume(applyFinish(run(), { reason: "done" }, T1), {}, [], T2), /is finished \(done\)/);
});

test("mergeErrors: 'merged' needs the merge, a green verify that covers it and the story done", () => {
  const state = claimed(run());
  const claim = state.claims["ST-001"];
  const ok = {
    current: BRANCH, dirty: [], storyStatus: "done", branchExists: true, branchMerged: true,
    verify: { branch: BRANCH, ok: true, commit: "abc1234", dirty: false, failed: [] }, verifyCoversMerge: true, changedSinceVerify: [],
  };
  const errs = (over) => mergeErrors(state, "ST-001", claim, { ...ok, ...over }).join("\n");
  assert.equal(errs({}), "");
  assert.match(errs({ current: "st-001-demo" }), /not on the integration branch/);
  assert.match(errs({ branchMerged: false }), /'st-001-demo' is not merged into 'marathon\/2026-11-26' – git merge --no-ff st-001-demo/);
  assert.match(errs({ verify: null }), /verify\.ts has not run on 'marathon\/2026-11-26' after the merge/);
  assert.match(errs({ verify: { ...ok.verify, branch: "st-001-demo" } }), /has not run on/);
  assert.match(errs({ verify: { ...ok.verify, ok: false, failed: ["test"] } }), /verify\.ts is red .*\(test\) – record `result ST-001 failed`/);
  assert.match(errs({ verifyCoversMerge: false }), /was before the merge of 'st-001-demo'/);
  assert.match(errs({ changedSinceVerify: ["src/order.ts"] }), /code changed after the green verify \(src\/order\.ts\)/);
  assert.match(errs({ storyStatus: "in-progress" }), /story-status\.ts ST-001 done/);
  assert.match(errs({ dirty: ["CONTEXT.md"] }), /uncommitted changes: CONTEXT\.md/);
});

test("finish: needs a reason and no open claim; the pull request is recorded afterwards", () => {
  assert.throws(() => applyFinish(claimed(run()), { reason: "limit" }, T1), /ST-001 is still claimed/);
  assert.throws(() => applyFinish(run(), {}, T1), /no reason to stop yet/);
  const done = applyFinish(run(), { reason: "no story is ready" }, T1);
  assert.deepEqual(done.stop, { reason: "no story is ready", at: T1, pr: null });
  assert.deepEqual(marathonStateErrors(done), []);
  assert.throws(() => applyFinish(done, { reason: "again" }, T2), /finished already/);
  assert.deepEqual(applyFinish(done, { pr: "https://example.test/pr/7" }, T2).stop, { reason: "no story is ready", at: T1, pr: "https://example.test/pr/7" });
  assert.throws(() => claimed(done), /is finished \(no story is ready\) – start a new run/);
});

test("parseDetails: questions and notes, or a worker report as it is", () => {
  assert.deepEqual(parseDetails(undefined), { details: none, errors: [] });
  const report = { report: "implement-worker", version: 1, story: "ST-001", result: "blocked", reason: "…", openQuestions: [{ question: "Which seam?", kind: "technical" }], newTerms: [] };
  assert.deepEqual(parseDetails(report).details, { openQuestions: [{ question: "Which seam?", kind: "technical" }], decisions: [], notes: [] });
  const decided = { ...report, result: "ready-for-review", openQuestions: [], decisions: [{ question: "Time zone of today?", decision: "the process's local time zone", why: "no rule; conventions name days without a zone" }] };
  assert.deepEqual(parseDetails(decided).details.decisions, decided.decisions);
  assert.deepEqual(parseDetails({ decisions: [{ question: "q", decision: "d", why: "w" }] }).details.decisions, [{ question: "q", decision: "d", why: "w" }]);
  assert.match(parseDetails({ decisions: [{ question: "q" }] }).errors[0], /decisions\[0\] needs question, decision and why/);
  assert.deepEqual(parseDetails(report).errors, []);
  assert.deepEqual(parseDetails({ notes: ["ADR 0007 proposed"] }).details.notes, ["ADR 0007 proposed"]);
  assert.match(parseDetails({ note: "x" }).errors[0], /unknown key 'note'/);
  assert.match(parseDetails({ openQuestions: [{ kind: "domain" }] }).errors[0], /openQuestions\[0\] needs question/);
  assert.match(parseDetails([]).errors[0], /must be a JSON object/);
});

test("renderSummary: merged stories, escalations with their reasons, open questions and the metrics", () => {
  let state = run();
  state = applyReview(claimed(state, "ST-001", "tech-task"), "ST-001", review("acceptance-tester", "accepted-with-remarks", { minor: 1 }), T1).state;
  state = applyMerged(state, "ST-001", { openQuestions: [{ question: "Keep the old export?", kind: "domain" }], notes: ["ADR 0007 proposed: queue"] }, T1);
  state = applyEscalate(claimed(state, "ST-002"), "ST-002", "blocked: no seam for the mailer", { openQuestions: [{ question: "Which seam | adapter?", kind: "technical" }], notes: [] }, T2);
  state = applyFailed(claimed(state, "ST-003"), "ST-003", "the worker returned no report", none, T2).state;
  state = applyFinish(state, { reason: "no story is ready" }, T2);
  const text = renderSummary(state, new Map([["ST-001", "Set up CI"], ["ST-002", "Send the reminder"]]), "| Story | Total |\n|---|---|\n| ST-001 | $1.20 |");
  assert.match(text, /^# Marathon 2026-11-26$/m);
  assert.match(text, /`marathon\/2026-11-26` → `main` .* \*\*1 merged\*\*, 1 escalated, 1 failed/);
  assert.match(text, /\*\*Why the run ended:\*\* no story is ready/);
  assert.match(text, /\| ST-001 \| Set up CI \| tech-task \| 1 \| acceptance-tester: accepted with remarks \(0B 0M 1m 0Q\) \|/);
  assert.match(text, /- ST-001: ADR 0007 proposed: queue/);
  assert.match(text, /- \*\*ST-002 – Send the reminder\*\* – blocked: no seam for the mailer\n {2}- branch `st-002-demo` \(local, not merged\) · 1 pass\(es\)/);
  assert.match(text, /## Failed passes\n\n- \*\*ST-003\*\* – the worker returned no report/);
  assert.match(text, /- \*\*ST-002\*\* \(technical\): Which seam \| adapter\?\n- \*\*ST-001\*\* \(domain\): Keep the old export\?/);
  assert.match(text, /## Metrics\n\n\| Story \| Total \|/);
  assert.match(renderSummary(run(), new Map(), "none"), /## Escalations\n\nNone\./);
});

// --------------------------------------------------------------------------
// Lock and atomic write
// --------------------------------------------------------------------------
const scratch = () => join(mkdtempSync(join(tmpdir(), "kataster-marathon-lock-")), "marathon.json");
const lockOf = (path, holder, ageMs = 0) => {
  writeFileSync(`${path}.lock`, typeof holder === "string" ? holder : JSON.stringify(holder), "utf8");
  if (ageMs) {
    const then = new Date(Date.now() - ageMs);
    utimesSync(`${path}.lock`, then, then);
  }
};
/** A PID that is certainly not running: a child that has exited. */
const deadPid = () => spawnSync(process.execPath, ["-e", ""]).pid;

test("lock: taken exclusively and given back, also when the section throws", () => {
  const path = scratch();
  const seen = withStateLock(path, () => JSON.parse(readFileSync(`${path}.lock`, "utf8")));
  assert.equal(seen.pid, process.pid);
  assert.equal(seen.host, hostname());
  assert.equal(existsSync(`${path}.lock`), false);
  assert.throws(() => withStateLock(path, () => { throw new Error("boom"); }), /boom/);
  assert.equal(existsSync(`${path}.lock`), false);
});

test("lock: a live lock is waited for and then refused – never broken", () => {
  const path = scratch();
  lockOf(path, { pid: process.pid, host: hostname(), at: new Date().toISOString() });
  const warnings = [];
  assert.throws(() => acquireLock(path, { waitMs: 150, warn: (m) => warnings.push(m) }), (err) => err instanceof MarathonError && /is locked by another writer/.test(err.message));
  assert.deepEqual(warnings, []);
  assert.equal(existsSync(`${path}.lock`), true, "the other writer's lock is still there");
});

test("lock: a stale lock is recognised and broken with a warning", () => {
  // The holder's process is gone.
  let path = scratch();
  const pid = deadPid();
  lockOf(path, { pid, host: hostname(), at: "2026-11-26T09:00:00.000Z" });
  let warnings = [];
  acquireLock(path, { waitMs: 150, warn: (m) => warnings.push(m) })();
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], new RegExp(`stale lock .*marathon\\.json\\.lock \\(pid ${pid}, since 2026-11-26T09:00:00\\.000Z – that process is gone\\) – broken`));
  assert.equal(existsSync(`${path}.lock`), false);

  // The holder may live on another host, but nobody holds this lock for minutes.
  path = scratch();
  lockOf(path, { pid: 1, host: "another-host", at: "2026-11-26T09:00:00.000Z" }, 120_000);
  warnings = [];
  acquireLock(path, { waitMs: 150, staleMs: 60_000, warn: (m) => warnings.push(m) })();
  assert.match(warnings[0], /held for 1[12]\d s\) – broken/);

  // A writer died before it wrote who it is.
  path = scratch();
  lockOf(path, "", 5000);
  warnings = [];
  acquireLock(path, { waitMs: 150, warn: (m) => warnings.push(m) })();
  assert.match(warnings[0], /no holder recorded/);
});

test("writeMarathonState: atomic – the old file or the new one, and never an invalid one", () => {
  const path = scratch();
  writeMarathonState(run(), path);
  const before = readFileSync(path, "utf8");
  assert.deepEqual(JSON.parse(before), run());
  assert.throws(() => writeMarathonState({ ...run(), status: "paused" }, path), /refusing to write an invalid marathon state/);
  assert.equal(readFileSync(path, "utf8"), before);
  assert.deepEqual(readdirSync(dirname(path)), ["marathon.json"], "no temp file is left behind");
});

// --------------------------------------------------------------------------
// marathon-state.ts – installed into a project, run like a harness runs it
// --------------------------------------------------------------------------
function git(dir, ...args) {
  const r = spawnSync("git", ["-c", "user.email=marathon@example.test", "-c", "user.name=Marathon", ...args], { cwd: dir, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stdout}${r.stderr}`);
  return r.stdout.trim();
}

function write(dir, path, content) {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), content, "utf8");
}

const storyText = (id, status, { type = "chore", extra = "" } = {}) =>
  `---\nid: ${id}\ntitle: Demo ${id}\ntype: ${type}\nstatus: ${status}\npriority: should\nsize: S\n${extra}---\n\n## Task\nTidy up.\n\n## Acceptance Criteria\n\n- [x] Tidied\n`;
const storyPath = (id) => `docs/stories/${id}-demo.md`;

/** An installed project on `main` with ST-001 … ST-003 `ready` and committed. */
function repo(stories = ["ST-001", "ST-002", "ST-003"], types = {}) {
  const dir = mkdtempSync(join(tmpdir(), "kataster-marathon-state-"));
  write(dir, "package.json", JSON.stringify({ name: "shop" }));
  write(dir, "src/order.ts", "export const order = 1;\n");
  for (const id of stories) write(dir, storyPath(id), storyText(id, "ready", { type: types[id] ?? "chore" }));
  const init = spawnSync(process.execPath, [cli, "init", dir, "--yes", "--no-install"], { cwd: dir, encoding: "utf8" });
  assert.equal(init.status, 0, `${init.stdout}${init.stderr}`);
  mkdirSync(join(dir, ".claude", "node_modules"), { recursive: true });
  cpSync(yamlSource, join(dir, ".claude", "node_modules", "yaml"), { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  return dir;
}

function script(dir, name, args, { input, now = T0, env = {} } = {}) {
  const r = spawnSync(process.execPath, [join(dir, ".claude", "skills", ...name), ...args], {
    cwd: dir,
    encoding: "utf8",
    input,
    env: { ...process.env, KATASTER_MARATHON_NOW: now, KATASTER_METRICS_NOW: now, KATASTER_MARATHON_LOCK_WAIT_MS: "300", ...env },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}`, stdout: r.stdout, err: r.stderr };
}
const ms = (dir, args, opts) => script(dir, ["marathon", "scripts", "marathon-state.ts"], args, opts);
const planner = (dir, args = []) => script(dir, ["marathon", "scripts", "marathon-plan.ts"], args);
const stateFile = (dir) => join(dir, ".claude", "state", "marathon.json");
const readState = (dir) => JSON.parse(readFileSync(stateFile(dir), "utf8"));
const branch = (dir) => git(dir, "rev-parse", "--abbrev-ref", "HEAD");
const ok = (r) => {
  assert.equal(r.code, 0, r.out);
  return r;
};

/** What a worker's first pass leaves behind: the story branch with the story `in-progress` and the work committed. */
function workerPass(dir, id) {
  const name = `${id.toLowerCase()}-demo`;
  git(dir, "switch", "-q", "-c", name);
  write(dir, storyPath(id), storyText(id, "in-progress"));
  write(dir, `src/${id.toLowerCase()}.ts`, `export const done = "${id}";\n`);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", `${id}: tidy up`);
  return name;
}

/** The state `verify.ts` leaves behind for the current head. */
function verified(dir, over = {}) {
  write(dir, ".claude/state/last-verify.json", JSON.stringify({
    at: T1, branch: branch(dir), commit: git(dir, "rev-parse", "--short", "HEAD"), dirty: false, ok: true, steps: [{ name: "test", ok: true }], ...over,
  }));
}

/** The orchestrator's merge step up to the commit `ST-NNN: done`. */
function integrate(dir, id, { verify = true } = {}) {
  git(dir, "switch", "-q", BRANCH);
  git(dir, "merge", "-q", "--no-ff", `${id.toLowerCase()}-demo`, "-m", `Merge ${id}: Demo ${id}`);
  if (verify) verified(dir);
  write(dir, storyPath(id), storyText(id, "done"));
  write(dir, "CONTEXT.md", `# Context\n\n**Tidying**: what ${id} did.\n`);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", `${id}: done`);
}

test("start-run: cuts marathon/<date> from the default branch, writes the state and refuses a second run", () => {
  const dir = repo();
  const r = ok(ms(dir, ["start-run", "--max-stories", "4", "--budget-tokens", "2.5M"]));
  assert.match(r.out, /RUN {10}2026-11-26 → marathon\/2026-11-26 \(from main\)/);
  assert.match(r.out, /LIMITS {7}4 stories, 3 failures in a row, foundation gate on, 2500000 tokens/);
  assert.match(r.out, /NEXT {9}ST-001 – Demo ST-001/);
  assert.equal(branch(dir), BRANCH);
  assert.equal(git(dir, "rev-parse", "HEAD"), git(dir, "rev-parse", "main"));
  const state = readState(dir);
  assert.deepEqual(marathonStateErrors(state), []);
  assert.deepEqual(
    { run: state.run, integrationBranch: state.integrationBranch, base: state.base, status: state.status, startedAt: state.startedAt, limits: state.limits },
    { run: "2026-11-26", integrationBranch: BRANCH, base: "main", status: "running", startedAt: T0, limits: { maxStories: 4, maxFailures: 3, gateFoundation: true, budgetTokens: 2_500_000, budgetUsd: null } },
  );
  assert.equal(existsSync(`${stateFile(dir)}.lock`), false);

  const second = ms(dir, ["start-run"]);
  assert.equal(second.code, 1);
  assert.match(second.out, /Run 2026-11-26 \(marathon\/2026-11-26\) is not finished – .*resume.* goes on with it/);
  assert.deepEqual(readState(dir), state);
});

test("start-run: needs a clean tree, something to run and arguments it knows – and creates nothing otherwise", () => {
  const dir = repo();
  write(dir, "src/order.ts", "export const order = 2;\n");
  const dirty = ms(dir, ["start-run"]);
  assert.equal(dirty.code, 1);
  assert.match(dirty.out, /uncommitted changes \(src\/order\.ts\) – a run starts from a clean tree/);
  git(dir, "checkout", "-q", "--", "src/order.ts");

  assert.equal(ms(dir, ["start-run", "--max-stories", "0"]).code, 2);
  assert.equal(ms(dir, ["start-run", "--budget-usd", "lots"]).code, 2);
  assert.equal(ms(dir, ["start-run", "--bogus"]).code, 2);
  assert.equal(ms(dir, ["start-run", "ST-001"]).code, 2);
  assert.equal(ms(dir, ["start-run", "--base", "release"]).code, 1);
  assert.equal(ms(dir, []).code, 2);
  assert.equal(ms(dir, ["launch"]).code, 2);
  assert.equal(ms(dir, ["--help"]).code, 0);

  const empty = repo([]);
  const nothing = ms(empty, ["start-run"]);
  assert.equal(nothing.code, 1);
  assert.match(nothing.out, /Nothing to run: the backlog is empty\. No branch was created\./);

  for (const d of [dir, empty]) {
    assert.equal(existsSync(stateFile(d)), false);
    assert.equal(branch(d), "main");
    assert.equal(git(d, "branch", "--list", "marathon/*"), "");
  }
  // Collected metrics do not make the tree dirty; they come along to the integration branch.
  write(dir, "docs/stories/metrics/ST-001.json", '{"version":1,"target":"ST-001","entries":[]}\n');
  ok(ms(dir, ["start-run", "--no-gate-foundation"]));
  assert.equal(readState(dir).limits.gateFoundation, false);
});

test("claim: the planned story only, on the integration branch, one at a time", () => {
  const dir = repo();
  const before = ms(dir, ["claim", "ST-001"]);
  assert.equal(before.code, 1);
  assert.match(before.out, /No marathon run: .*start-run/);
  ok(ms(dir, ["start-run"]));

  const other = ms(dir, ["claim", "ST-002"]);
  assert.equal(other.code, 1);
  assert.match(other.out, /ST-002 is not the planned story – marathon-plan\.ts says ST-001/);

  git(dir, "switch", "-q", "main");
  const elsewhere = ms(dir, ["claim", "ST-001"]);
  assert.equal(elsewhere.code, 1);
  assert.match(elsewhere.out, /The checkout is on 'main' – a story is claimed on the integration branch/);
  git(dir, "switch", "-q", BRANCH);

  const r = ok(ms(dir, ["claim", "st-001"]));
  assert.match(r.out, /CLAIMED {6}ST-001 on st-001-demo – pass 1/);
  assert.deepEqual(readState(dir).claims["ST-001"], { branch: "st-001-demo", start: T0, attempts: 1, type: "chore", phase: "worker", passStart: T0, reviews: [] });

  const serial = ms(dir, ["claim", "ST-002"]);
  assert.equal(serial.code, 1);
  assert.match(serial.out, /ST-001 is still claimed – a serial run holds one story at a time/);

  // With a story in hand the planner plans nothing and does not call it a stop.
  const p = JSON.parse(planner(dir, ["--json"]).stdout);
  assert.deepEqual([p.wave, p.stop, p.claimed], [[], null, ["ST-001"]]);

  // A further pass needs the branch the first one created.
  const early = ms(dir, ["claim", "ST-001", "--continue"]);
  assert.equal(early.code, 1);
  assert.match(early.out, /story branch 'st-001-demo' does not exist – there is nothing to continue/);
  ok(ms(dir, ["release", "ST-001"]));
  assert.deepEqual(readState(dir).claims, {});
});

test("a story's way through the run: claim, reviews, a fixes pass, the merge gate, the result", () => {
  const dir = repo();
  ok(ms(dir, ["start-run"]));
  ok(ms(dir, ["claim", "ST-001"]));
  workerPass(dir, "ST-001");

  // Round 1: the code reviewer wants a blocker fixed, the acceptance tester accepts.
  let r = ok(ms(dir, ["review", "ST-001", "code-reviewer", "--verdict", "fix-blockers-first", "--blocker", "1", "--minor", "2"], { now: T1 }));
  assert.match(r.out, /REVIEW {7}ST-001 code-reviewer: fix blockers first – 1 blocker, 0 major, 2 minor, 0 question/);
  assert.match(r.out, /NEXT {9}fixes – a worker pass with the findings \(1 blocker, 0 major this round\): .*claim ST-001 --continue/);
  r = ok(ms(dir, ["review", "ST-001", "acceptance-tester", "--verdict", "accepted", "--json"], { now: T1 }));
  assert.deepEqual(JSON.parse(r.stdout).next, { action: "fixes", then: "merge", notAccepted: 0, round: { blocker: 1, major: 0, minor: 2, question: 0 } });
  assert.equal(ms(dir, ["review", "ST-001", "acceptance-tester", "--verdict", "fine"]).code, 2);
  assert.equal(ms(dir, ["review", "ST-001", "--verdict", "accepted"]).code, 2);
  assert.equal(ms(dir, ["review", "ST-002", "acceptance-tester", "--verdict", "accepted"]).code, 1);

  // The reviews are in the story metrics as well, on the story branch.
  const metrics = JSON.parse(readFileSync(join(dir, "docs/stories/metrics/ST-001.json"), "utf8"));
  assert.deepEqual(metrics.reviews.map((x) => [x.agent, x.verdict, x.blocker, x.minor, x.at]), [["code-reviewer", "fix-blockers-first", 1, 2, T1], ["acceptance-tester", "accepted", 0, 0, T1]]);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "ST-001: review round 1");

  r = ok(ms(dir, ["claim", "ST-001", "--continue"], { now: T2 }));
  assert.match(r.out, /CLAIMED {6}ST-001 on st-001-demo – pass 2 \(continuation\)/);
  write(dir, "src/st-001.ts", 'export const done = "ST-001 fixed";\n');
  git(dir, "commit", "-q", "-am", "ST-001: fix the blocker");

  // The merge gate: every step the orchestrator owes is named until it is done.
  const notYet = ms(dir, ["result", "ST-001", "merged"]);
  assert.equal(notYet.code, 1);
  assert.match(notYet.out, /ST-001 is not merged:/);
  assert.match(notYet.out, /not on the integration branch/);
  assert.match(notYet.out, /'st-001-demo' is not merged into 'marathon\/2026-11-26'/);
  assert.match(notYet.out, /verify\.ts has not run on 'marathon\/2026-11-26' after the merge/);
  assert.match(notYet.out, /not 'done' – after the merge: story-status\.ts ST-001 done/);

  integrate(dir, "ST-001", { verify: false });
  assert.match(ms(dir, ["result", "ST-001", "merged"]).out, /verify\.ts has not run on/);
  verified(dir, { commit: git(dir, "rev-parse", "--short", "main") });
  assert.match(ms(dir, ["result", "ST-001", "merged"]).out, /was before the merge of 'st-001-demo'/);
  // Verified at the merge commit; the commit after it is bookkeeping (story, glossary) and keeps the run valid.
  verified(dir, { commit: git(dir, "rev-parse", "--short", "HEAD~1") });
  assert.equal(readState(dir).claims["ST-001"].attempts, 2, "a refused result changes nothing");

  r = ok(ms(dir, ["result", "ST-001", "merged", "--details", "-"], { now: T2, input: JSON.stringify({ notes: ["new term: Tidying"] }) }));
  assert.match(r.out, /RESULT {7}ST-001 merged into marathon\/2026-11-26/);
  const state = readState(dir);
  assert.deepEqual(state.claims, {});
  assert.equal(state.results["ST-001"].outcome, "merged");
  assert.equal(state.results["ST-001"].attempts, 2);
  assert.equal(state.results["ST-001"].reviews.length, 2);
  assert.deepEqual(state.results["ST-001"].notes, ["new term: Tidying"]);

  // The next story is planned from the integration branch, where ST-001 is done.
  assert.match(planner(dir).out, /NEXT {9}ST-002/);
  assert.match(ok(ms(dir, ["status"])).out, /STORIES {6}1 of 6 started: 1 merged, 0 escalated, 0 failed[\s\S]*NEXT {9}ST-002 – claim it/);
});

test("code that changes after the green verify makes it stale – bookkeeping does not", () => {
  const dir = repo();
  ok(ms(dir, ["start-run"]));
  ok(ms(dir, ["claim", "ST-001"]));
  workerPass(dir, "ST-001");
  integrate(dir, "ST-001", { verify: false });
  verified(dir, { commit: git(dir, "rev-parse", "--short", "HEAD~1") });
  write(dir, "src/order.ts", "export const order = 3;\n");
  git(dir, "commit", "-q", "-am", "a fix after verify");
  const r = ms(dir, ["result", "ST-001", "merged"]);
  assert.equal(r.code, 1);
  assert.match(r.out, /code changed after the green verify \(src\/order\.ts\) – run verify\.ts again/);
});

test("the run stops with exit 3: the story limit, a red verify on the integration branch, the failures in a row", () => {
  const dir = repo();
  ok(ms(dir, ["start-run", "--max-stories", "1", "--max-failures", "1"]));
  ok(ms(dir, ["claim", "ST-001"]));
  workerPass(dir, "ST-001");
  integrate(dir, "ST-001");
  verified(dir, { commit: git(dir, "rev-parse", "--short", "HEAD~1") });
  ok(ms(dir, ["result", "ST-001", "merged"]));

  const limit = ms(dir, ["claim", "ST-002"]);
  assert.equal(limit.code, 3);
  assert.match(limit.out, /STOP {9}the run has started 1 story \(limit 1\) – end the run/);
  assert.deepEqual(readState(dir).claims, {});
  const p = planner(dir);
  assert.match(p.out, /STOP {9}the run has started 1 story \(limit 1\)/);
  assert.doesNotMatch(p.out, /NEXT/);
  assert.equal(JSON.parse(planner(dir, ["--json"]).stdout).stop, "the run has started 1 story (limit 1)");

  // finish takes the reason from the same check.
  const end = ok(ms(dir, ["finish"], { now: T2 }));
  assert.match(end.out, /FINISHED {5}2026-11-26 – the run has started 1 story \(limit 1\)/);
  assert.match(end.out, /NEXT {9}node \.claude\/skills\/metrics\/scripts\/story-metrics\.ts collect --since 2026-11-26T12:00:00\.000Z/);
  assert.match(end.out, /THEN {9}.* summary --out \.claude\/state\/marathon-pr\.md, push marathon\/2026-11-26, open the pull request/);
  assert.deepEqual(readState(dir).stop, { reason: "the run has started 1 story (limit 1)", at: T2, pr: null });
  assert.equal(ms(dir, ["claim", "ST-002"]).code, 1, "a finished run takes no story");
  assert.match(planner(dir).out, /STOP {9}run 2026-11-26 is finished/);

  // A red verify after a merge: the pass is failed, and nothing starts on a red integration branch.
  const red = repo();
  ok(ms(red, ["start-run"]));
  ok(ms(red, ["claim", "ST-001"]));
  workerPass(red, "ST-001");
  git(red, "switch", "-q", BRANCH);
  git(red, "merge", "-q", "--no-ff", "st-001-demo", "-m", "Merge ST-001");
  verified(red, { ok: false, steps: [{ name: "lint", ok: true }, { name: "test", ok: false }] });
  assert.match(ms(red, ["result", "ST-001", "merged"]).out, /verify\.ts is red on 'marathon\/2026-11-26' \(test\) – record `result ST-001 failed`/);
  assert.equal(ms(red, ["result", "ST-001", "failed"]).code, 2, "a failed pass needs its reason");
  ok(ms(red, ["result", "ST-001", "failed", "--reason", "verify red on the integration branch after the merge: test"]));
  const stop = ms(red, ["claim", "ST-002"]);
  assert.equal(stop.code, 3);
  assert.match(stop.out, /STOP {9}verify is red on marathon\/2026-11-26 \(test\) – a marathon stops there and repairs nothing/);
  assert.match(ok(ms(red, ["finish"])).out, /verify is red on marathon\/2026-11-26/);

  // Failures in a row.
  const rows = repo();
  ok(ms(rows, ["start-run", "--max-failures", "2"]));
  for (const id of ["ST-001", "ST-002"]) {
    ok(ms(rows, ["claim", id]));
    const r = ok(ms(rows, ["escalate", id, "--reason", "blocked: the test runner is missing"]));
    assert.match(r.out, new RegExp(`ESCALATED {4}${id} – blocked: the test runner is missing`));
  }
  assert.equal(ms(rows, ["escalate", "ST-003", "--reason", "x"]).code, 1, "only a claimed story is escalated");
  assert.equal(ms(rows, ["escalate", "ST-003"]).code, 2);
  const third = ms(rows, ["claim", "ST-003"]);
  assert.equal(third.code, 3);
  assert.match(third.out, /2 stories in a row ended without a merge \(limit 2\)/);
  assert.deepEqual(readState(rows).escalations.map((x) => x.branch), [undefined, undefined], "given up before a worker cut the branch: no branch to point at");
  assert.match(ok(ms(rows, ["summary"])).stdout, /- \*\*ST-001 – Demo ST-001\*\* – blocked: the test runner is missing\n {2}- no branch · 1 pass\(es\)/);
});

test("the budget is read from the story metrics – also from a story branch that was never merged", () => {
  const dir = repo();
  ok(ms(dir, ["start-run", "--budget-tokens", "10k"]));
  ok(ms(dir, ["claim", "ST-001"]));
  workerPass(dir, "ST-001");
  const entry = {
    key: "claude-code|s1|main|ST-001|implementierung|1|m", target: "ST-001", phase: "implementierung", harness: "claude-code", run: "s1", session: "s1", agent: "main", agentType: "main",
    model: "model-x", provider: "acme", start: T1, end: T2, messages: 3, tokens: { input: 2000, output: 3000, reasoning: 0, cacheRead: 6000, cacheWrite: 1000, cacheWrite1h: 0 },
    harnessCostUsd: null, agentMs: 60_000, userWaitMs: 0, recorded: T2,
  };
  write(dir, "docs/stories/metrics/ST-001.json", `{"version":1,"target":"ST-001","entries":[\n${JSON.stringify(entry)}\n]}\n`);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "ST-001: metrics");
  // The story is escalated: its branch – and its metrics – never reach the integration branch.
  ok(ms(dir, ["escalate", "ST-001", "--reason", "blocked: a decision is missing"]));
  git(dir, "switch", "-q", BRANCH);
  assert.equal(existsSync(join(dir, "docs/stories/metrics/ST-001.json")), false);

  const status = JSON.parse(ok(ms(dir, ["status", "--json"])).stdout);
  assert.deepEqual(status.usage, { tokens: 12_000, costUsd: null, unpriced: ["acme/model-x"] });
  assert.deepEqual(status.next, { action: "stop", reason: "the token budget is used up: 12k of 10k" });
  const stop = ms(dir, ["claim", "ST-002"]);
  assert.equal(stop.code, 3);
  assert.match(stop.out, /the token budget is used up: 12k of 10k/);

  ok(ms(dir, ["finish"]));
  const summary = ok(ms(dir, ["summary"])).stdout;
  assert.match(summary, /\*\*Why the run ended:\*\* the token budget is used up/);
  assert.match(summary, /- \*\*ST-001 – Demo ST-001\*\* – blocked: a decision is missing\n {2}- branch `st-001-demo` \(local, not merged\)/);
  assert.match(summary, /## Metrics\n\n\| Story +\| Size/);
  assert.match(summary, /\| ST-001 +\| S /);
  assert.match(summary, /\*\*Run:\*\* 12000 tokens · cost unknown/);
  const out = ok(ms(dir, ["summary", "--out", ".claude/state/marathon-pr.md"]));
  assert.match(out.out, /WRITTEN {6}\.claude\/state\/marathon-pr\.md/);
  assert.equal(readFileSync(join(dir, ".claude/state/marathon-pr.md"), "utf8").trim(), summary.trim());
});

test("the foundation gate ends the run between the foundation tasks and the first other story", () => {
  const dir = repo(["ST-001", "ST-002"], { "ST-001": "tech-task" });
  ok(ms(dir, ["start-run"]));
  ok(ms(dir, ["claim", "ST-001"]));
  assert.equal(readState(dir).claims["ST-001"].type, "tech-task");
  workerPass(dir, "ST-001");
  git(dir, "switch", "-q", BRANCH);
  git(dir, "merge", "-q", "--no-ff", "st-001-demo", "-m", "Merge ST-001");
  verified(dir);
  write(dir, storyPath("ST-001"), storyText("ST-001", "done", { type: "tech-task" }));
  git(dir, "commit", "-q", "-am", "ST-001: done");
  // A tech task takes the full lane: no merge without the acceptance tester.
  const unreviewed = ms(dir, ["result", "ST-001", "merged"]);
  assert.equal(unreviewed.code, 1);
  assert.match(unreviewed.out, /a tech-task story is merged only after the acceptance-tester accepted it/);
  ok(ms(dir, ["review", "ST-001", "acceptance-tester", "--verdict", "accepted"]));
  ok(ms(dir, ["result", "ST-001", "merged"]));
  const gate = ms(dir, ["claim", "ST-002"]);
  assert.equal(gate.code, 3);
  assert.match(gate.out, /foundation gate: ST-001 merged and ST-002 is no foundation task/);
});

test("a broken state file is refused by every command and never overwritten", () => {
  const dir = repo();
  for (const broken of ["{ not json", JSON.stringify({ version: 1, run: "x" })]) {
    write(dir, ".claude/state/marathon.json", broken);
    for (const args of [["start-run"], ["claim", "ST-001"], ["claim", "ST-001", "--continue"], ["review", "ST-001", "acceptance-tester", "--verdict", "accepted"], ["result", "ST-001", "failed", "--reason", "x"],
      ["escalate", "ST-001", "--reason", "x"], ["release", "ST-001"], ["resume"], ["finish", "--reason", "x"], ["status"], ["summary"]]) {
      const r = ms(dir, args);
      assert.equal(r.code, 1, `${args.join(" ")}: ${r.out}`);
      assert.match(r.out, /marathon\.json is (not valid JSON|invalid)/, args.join(" "));
      assert.match(r.out, /never overwritten while it is broken/);
    }
    assert.equal(readFileSync(stateFile(dir), "utf8"), broken);
    assert.equal(existsSync(`${stateFile(dir)}.lock`), false, "a refused command gives its lock back");
  }
  assert.equal(branch(dir), "main", "start-run created no branch");
});

test("marathon-state.ts: breaks a stale lock with a warning and refuses to write next to a live one", () => {
  const dir = repo();
  ok(ms(dir, ["start-run"]));
  const lock = `${stateFile(dir)}.lock`;

  writeFileSync(lock, JSON.stringify({ pid: deadPid(), host: hostname(), at: "2026-11-26T09:00:00.000Z" }));
  const stale = ok(ms(dir, ["claim", "ST-001"]));
  assert.match(stale.err, /⚠ stale lock \.claude\/state\/marathon\.json\.lock \(pid \d+, since 2026-11-26T09:00:00\.000Z – that process is gone\) – broken/);
  assert.match(stale.out, /CLAIMED {6}ST-001/);
  assert.equal(existsSync(lock), false);

  const before = readFileSync(stateFile(dir), "utf8");
  writeFileSync(lock, JSON.stringify({ pid: process.pid, host: hostname(), at: new Date().toISOString() }));
  const live = ms(dir, ["release", "ST-001"]);
  assert.equal(live.code, 1);
  assert.match(live.out, /\.claude\/state\/marathon\.json is locked by another writer/);
  assert.equal(readFileSync(stateFile(dir), "utf8"), before);
  assert.equal(existsSync(lock), true, "the live lock is left alone");
  // Reading needs no lock.
  ok(ms(dir, ["status"]));
  rmSync(lock);
});

test("resume: an orphaned claim with its branch is continued and counts as a pass", () => {
  const dir = repo();
  ok(ms(dir, ["start-run"]));
  ok(ms(dir, ["claim", "ST-001"]));
  workerPass(dir, "ST-001");
  // The session ended mid-pass: uncommitted work on the story branch.
  write(dir, "src/st-001.ts", "export const done = 1; // half an edit\n");

  const r = ok(ms(dir, ["resume"], { now: T1 }));
  assert.match(r.out, /RUN {10}2026-11-26 → marathon\/2026-11-26 \(from main\)/);
  assert.match(r.out, /CHECKOUT {5}st-001-demo – 1 uncommitted path\(s\): src\/st-001\.ts/);
  assert.match(r.out, /CONTINUE {5}ST-001 on st-001-demo – orphaned claim; start a story-worker continuation \(pass 2\)/);
  const claim = readState(dir).claims["ST-001"];
  assert.deepEqual([claim.attempts, claim.phase, claim.passStart], [2, "worker", T1]);

  // Resuming again is the next attempt; a worker the session still waits for is left alone.
  const kept = ok(ms(dir, ["resume", "--running", "ST-001"], { now: T2 }));
  assert.match(kept.out, /RUNNING {6}ST-001 on st-001-demo – its worker is still at work/);
  assert.equal(readState(dir).claims["ST-001"].attempts, 2);
  assert.equal(ms(dir, ["resume", "--running", "ST-002"]).code, 1);
});

test("resume: an orphaned claim without a branch is released and the story is planned again", () => {
  const dir = repo();
  ok(ms(dir, ["start-run"]));
  ok(ms(dir, ["claim", "ST-001"]));
  // The worker never got as far as its branch.
  const r = ok(ms(dir, ["resume"], { now: T1 }));
  assert.match(r.out, /CHECKOUT {5}marathon\/2026-11-26, clean/);
  assert.match(r.out, /RELEASED {5}ST-001 – orphaned claim without the branch st-001-demo; back in the plan/);
  assert.match(r.out, /NEXT {9}ST-001 – plan and claim it/);
  const state = readState(dir);
  assert.deepEqual([state.claims, state.results, state.escalations], [{}, {}, []]);
  assert.match(ok(ms(dir, ["claim", "ST-001"])).out, /pass 1/, "the released claim did not count");
});

test("resume: a story that is merged or accepted goes on with the merge step, without a worker pass", () => {
  const dir = repo();
  ok(ms(dir, ["start-run"]));
  ok(ms(dir, ["claim", "ST-001"]));
  workerPass(dir, "ST-001");
  // Accepted, not merged yet.
  ok(ms(dir, ["review", "ST-001", "acceptance-tester", "--verdict", "accepted"], { now: T1 }));
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "ST-001: review round 1");
  let r = ok(ms(dir, ["resume"], { now: T2 }));
  assert.match(r.out, /MERGE {8}ST-001 on st-001-demo – accepted or merged already; go on with the merge step/);
  assert.equal(readState(dir).claims["ST-001"].attempts, 1);

  // Merged, the bookkeeping not finished: the same.
  git(dir, "switch", "-q", BRANCH);
  git(dir, "merge", "-q", "--no-ff", "st-001-demo", "-m", "Merge ST-001");
  write(dir, "CONTEXT.md", "# Context\n\n**Tidying**: half written\n");
  r = ok(ms(dir, ["resume"], { now: T2 }));
  assert.match(r.out, /CHECKOUT {5}marathon\/2026-11-26 – 1 uncommitted path\(s\): CONTEXT\.md/);
  assert.match(r.out, /MERGE {8}ST-001/);
});

test("resume: nothing claimed means the next story or the reason to stop; a finished run points at its pull request", () => {
  const dir = repo(["ST-001"]);
  assert.equal(ms(dir, ["resume"]).code, 1, "no run to resume");
  ok(ms(dir, ["start-run"]));
  assert.match(ok(ms(dir, ["resume"])).out, /CLAIMS {7}none open\nNEXT {9}ST-001 – plan and claim it/);

  ok(ms(dir, ["claim", "ST-001"]));
  ok(ms(dir, ["escalate", "ST-001", "--reason", "blocked", "--details", "-"], {
    input: `\`\`\`json\n${JSON.stringify({ report: "implement-worker", version: 1, story: "ST-001", result: "blocked", reason: "blocked", openQuestions: [{ question: "Which seam?", kind: "technical" }] })}\n\`\`\`\n`,
  }));
  assert.deepEqual(readState(dir).escalations[0].openQuestions, [{ question: "Which seam?", kind: "technical" }], "the worker's fenced report block is read as it is");
  assert.match(ok(ms(dir, ["resume"])).out, /STOP {9}every ready story is claimed, merged or escalated – end the run/);

  ok(ms(dir, ["finish"], { now: T2 }));
  assert.match(ok(ms(dir, ["resume"])).out, /finished: every ready story is claimed, merged or escalated\nNEXT {9}push the integration branch and open the pull request/);
  const pr = ok(ms(dir, ["finish", "--pr", "https://example.test/pull/7"]));
  assert.match(pr.out, /PR {11}https:\/\/example\.test\/pull\/7/);
  assert.match(ok(ms(dir, ["resume"])).out, /NEXT {9}nothing – the pull request is open: https:\/\/example\.test\/pull\/7/);
  assert.match(ok(ms(dir, ["summary"])).stdout, /- \*\*ST-001\*\* \(technical\): Which seam\?/);

  // The next run archives the finished one and gets its own name.
  git(dir, "switch", "-q", "main");
  write(dir, storyPath("ST-002"), storyText("ST-002", "ready"));
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "ST-002");
  const next = ok(ms(dir, ["start-run"]));
  assert.match(next.out, /ARCHIVED {5}run 2026-11-26 → \.claude\/state\/marathon\/2026-11-26\.json/);
  assert.match(next.out, /RUN {10}2026-11-26-2 → marathon\/2026-11-26-2/);
  assert.equal(JSON.parse(readFileSync(join(dir, ".claude/state/marathon/2026-11-26.json"), "utf8")).stop.pr, "https://example.test/pull/7");
});

test("resume: refuses when the integration branch is gone", () => {
  const dir = repo();
  ok(ms(dir, ["start-run"]));
  git(dir, "switch", "-q", "main");
  git(dir, "branch", "-q", "-D", BRANCH);
  const r = ms(dir, ["resume"]);
  assert.equal(r.code, 1);
  assert.match(r.out, /integration branch 'marathon\/2026-11-26' of run 2026-11-26 does not exist/);
});

// --------------------------------------------------------------------------
// What a run touches outside its own script
// --------------------------------------------------------------------------
test("story-metrics.ts review: the record lands next to the entries and shows in the report", () => {
  const dir = repo();
  const sm = (args, now = T1) => script(dir, ["metrics", "scripts", "story-metrics.ts"], args, { now });
  const r = ok(sm(["review", "st-001", "code-reviewer", "--verdict", "ready-to-merge", "--minor", "3", "--question", "1"]));
  assert.match(r.out, /ST-001 review by code-reviewer: ready to merge – recorded in docs\/stories\/metrics\//);
  assert.match(ok(sm(["review", "ST-001", "code-reviewer", "--verdict", "ready-to-merge", "--minor", "3", "--question", "1"])).out, /already recorded/);
  ok(sm(["review", "ST-001", "acceptance-tester", "--verdict", "not-accepted", "--blocker", "1"], T2));
  assert.equal(sm(["review", "ST-001", "acceptance-tester", "--verdict", "maybe"]).code, 2);
  assert.equal(sm(["review", "ST-001", "acceptance-tester", "--verdict", "accepted", "--blocker", "x"]).code, 2);
  assert.equal(sm(["review", "feature:orders", "acceptance-tester", "--verdict", "accepted"]).code, 2);

  const file = JSON.parse(readFileSync(join(dir, "docs/stories/metrics/ST-001.json"), "utf8"));
  assert.deepEqual(file.entries, []);
  assert.equal(file.reviews.length, 2);
  const data = JSON.parse(ok(sm(["report", "--story", "ST-001", "--json"])).stdout);
  assert.deepEqual(data.stories[0].reviews.map((x) => [x.agent, x.verdict]), [["code-reviewer", "ready-to-merge"], ["acceptance-tester", "not-accepted"]]);
  const text = ok(sm(["report", "--story", "ST-001"])).out;
  assert.match(text, /## Reviews/);
  assert.match(text, /\| acceptance-tester \| not accepted +\| +1 \| +0 \| +0 \| +0 \| 2026-11-26 \|/);
});

test("the quick gate is off while a marathon claim is open – the uncommitted code is a worker's", () => {
  const dir = repo();
  // A type checker that is always red, and a changed code file.
  write(dir, "tsconfig.json", "{}");
  write(dir, "node_modules/.bin/tsc", "#!/bin/sh\necho 'error TS0000: red'\nexit 1\n");
  chmodSync(join(dir, "node_modules/.bin/tsc"), 0o755);
  write(dir, ".gitignore", `${readFileSync(join(dir, ".gitignore"), "utf8")}node_modules/\ntsconfig.json\n`);
  git(dir, "commit", "-q", "-am", "ignore");
  const gate = () => spawnSync(process.execPath, [join(dir, ".claude", "hooks", "stop-gate.ts")], { cwd: dir, encoding: "utf8", input: JSON.stringify({}), env: { ...process.env, CLAUDE_PROJECT_DIR: dir } });

  ok(ms(dir, ["start-run"]));
  write(dir, "src/order.ts", "export const order = 2;\n");
  assert.equal(gate().status, 2, "a running run without a claim keeps the gate");
  git(dir, "checkout", "-q", "--", "src/order.ts");
  ok(ms(dir, ["claim", "ST-001"]));
  write(dir, "src/order.ts", "export const order = 2;\n");
  assert.equal(gate().status, 0);
  ok(ms(dir, ["release", "ST-001"]));
  assert.equal(gate().status, 2);
});

test("the marathon state cannot be edited by hand", () => {
  const dir = repo();
  const hook = (path) => spawnSync(process.execPath, [join(dir, ".claude", "hooks", "protect-files.ts")], {
    input: JSON.stringify({ tool_name: "Write", tool_input: { file_path: join(dir, path), content: "{}" }, cwd: dir }), encoding: "utf8",
  });
  const blocked = hook(".claude/state/marathon.json");
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /changes only through `node \.claude\/skills\/marathon\/scripts\/marathon-state\.ts`/);
  assert.equal(hook(".claude/state/marathon/2026-11-26.json").status, 2);
  assert.equal(hook(".claude/state/marathon-pr.md").status, 0);
});

test("both harnesses ship the marathon: one skill, a command that only loads it, the scripts allowed", () => {
  const dir = repo();
  const skill = readFileSync(join(dir, ".claude/skills/marathon/SKILL.md"), "utf8");
  assert.match(skill, /^name: marathon$/m);
  assert.match(skill, /^disable-model-invocation: true$/m);
  const command = readFileSync(join(dir, ".opencode/commands/marathon.md"), "utf8");
  assert.match(command, /Load the `marathon` skill with the `skill` tool and follow it exactly/);
  assert.match(command, /Arguments: \$ARGUMENTS/);
  assert.equal(command.split("\n").filter((l) => l.trim() && !l.startsWith("---") && !l.startsWith("description:")).length, 2, "the command restates nothing");
  // How a worker is started and continued is documented for both harnesses, in the one skill.
  assert.match(skill, /\| Start \| `Agent` tool, `subagent_type: story-worker`.*\| `subagent` tool, `agent: story-worker`/);
  assert.match(skill, /\| Continue with findings \| `SendMessage`.*\| `subagent` again with that `sessionID` \|/);
  for (const name of ["marathon-state.ts", "marathon-plan.ts"]) assert.ok(existsSync(join(dir, ".claude/skills/marathon/scripts", name)), name);

  const call = "node .claude/skills/marathon/scripts/marathon-state.ts claim ST-001";
  const covers = (pattern) => pattern.endsWith("*") && call.startsWith(pattern.slice(0, -1));
  const settings = JSON.parse(readFileSync(join(dir, ".claude/settings.json"), "utf8"));
  assert.ok(settings.permissions.allow.some((entry) => /^Bash\((.+)\)$/.test(entry) && covers(/^Bash\((.+)\)$/.exec(entry)[1])), "Claude Code");
  const config = parseJsonc(readFileSync(join(dir, ".opencode/opencode.jsonc"), "utf8"));
  assert.ok(config.permissions.some((rule) => rule.action === "shell" && rule.effect === "allow" && covers(rule.resource)), "OpenCode");
  // The agents block of AGENTS.md names the run.
  assert.match(readFileSync(join(dir, "AGENTS.md"), "utf8"), /\*\*Marathon:\*\* `\/marathon`/);
});

// --------------------------------------------------------------------------
// The lease – two sessions on one run (a closed TUI leaves OpenCode's sessions running in its service)
// --------------------------------------------------------------------------
const wk = (dir, args, opts) => script(dir, ["implement", "scripts", "worker.ts"], args, opts);
function guardHook(dir, payload) {
  const r = spawnSync(process.execPath, [join(dir, ".claude", "hooks", "marathon-guard.ts")], { cwd: dir, input: JSON.stringify(payload), encoding: "utf8" });
  return r.status;
}
/** A worker's work on the branch `worker.ts start` put the checkout on: the story in progress, a commit, a green verify. */
function build(dir, id, line = "1") {
  write(dir, storyPath(id), storyText(id, "in-progress"));
  write(dir, `src/${id.toLowerCase()}.ts`, `export const done = ${line};\n`);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", `${id}: tidy up ${line}`);
  verified(dir);
}
const report = (dir, id, caller, result = "ready-for-review") =>
  wk(dir, ["report", id, "--base", BRANCH, "--result", result, "--details", "-", "--caller", caller], { input: JSON.stringify({ reason: "done" }) });

test("lease: a resumed run stops the orchestrator and the worker before it – they can write nothing, not even a report", () => {
  const dir = repo();
  ok(ms(dir, ["start-run", "--caller", "opencode:orch-a"]));
  ok(ms(dir, ["claim", "ST-001", "--caller", "opencode:orch-a"]));
  // Only the orchestrator writes.
  const foreign = ms(dir, ["claim", "ST-001", "--continue", "--caller", "opencode:orch-b"]);
  assert.equal(foreign.code, 1);
  assert.match(foreign.out, /opencode:orch-a is the orchestrator of run 2026-11-26/);

  const w1 = ok(wk(dir, ["start", "ST-001", "--base", BRANCH, "--caller", "opencode:w1"]));
  assert.match(w1.out, /LEASE {8}worker of ST-001, pass 1\n/);
  build(dir, "ST-001", "1");

  // The TUI is closed; orch-a and w1 live on in the service. A new session resumes the run.
  const r = ok(ms(dir, ["resume", "--caller", "opencode:orch-b"], { now: T1 }));
  assert.match(r.out, /SUPERSEDED {3}orchestrator opencode:orch-a – its tool calls are blocked from now on/);
  assert.match(r.out, /SUPERSEDED {3}worker opencode:w1 \(ST-001, pass 1\) – its tool calls are blocked from now on/);
  assert.match(r.out, /CONTINUE {5}ST-001 on st-001-demo – orphaned claim; start a story-worker continuation \(pass 2\)/);

  // From here the old sessions are refused by the scripts and blocked by the hook on every tool.
  const old = ms(dir, ["release", "ST-001", "--caller", "opencode:orch-a"]);
  assert.equal(old.code, 1);
  assert.match(old.out, /this session was replaced as the orchestrator of run 2026-11-26/);
  const bash = { tool_name: "Bash", tool_input: { command: "git commit -am wip" }, harness: "opencode" };
  assert.equal(guardHook(dir, { ...bash, session_id: "orch-a" }), 2);
  assert.equal(guardHook(dir, { ...bash, session_id: "w1" }), 2);
  assert.equal(guardHook(dir, { ...bash, session_id: "orch-b" }), 0);
  const late = report(dir, "ST-001", "opencode:w1");
  assert.equal(late.code, 1);
  assert.match(late.out, /ST-001: no report – this worker was replaced/);

  // The new worker takes the claim; its report is the one that counts, and it is kept for the run.
  const w2 = ok(wk(dir, ["start", "ST-001", "--base", BRANCH, "--caller", "opencode:w2"]));
  assert.match(w2.out, /LEASE {8}worker of ST-001, pass 2\n/);
  assert.equal(guardHook(dir, { ...bash, session_id: "w2" }), 0);
  ok(report(dir, "ST-001", "opencode:w2"));
  const kept = JSON.parse(readFileSync(join(dir, ".claude", "state", "marathon-reports", "ST-001.json"), "utf8"));
  assert.deepEqual([kept.run, kept.pass, kept.caller, kept.result, kept.head], ["2026-11-26", 2, "opencode:w2", "ready-for-review", git(dir, "rev-parse", "--short", "HEAD")]);
  ok(ms(dir, ["review", "ST-001", "code-reviewer", "--verdict", "ready-to-merge", "--caller", "opencode:orch-b"]));
});

test("resume: a pass that ended with a report is read, not run again; a pass cut off mid-work counts as resumed, not failed", () => {
  const dir = repo();
  ok(ms(dir, ["start-run"]));
  ok(ms(dir, ["claim", "ST-001"]));
  ok(wk(dir, ["start", "ST-001", "--base", BRANCH]));
  build(dir, "ST-001");
  ok(report(dir, "ST-001", "claude-code:a7", "blocked"));

  // The orchestrator was cut off before it read the report.
  const r = ok(ms(dir, ["resume"], { now: T1 }));
  assert.match(r.out, /REPORT {7}ST-001 on st-001-demo – pass 1 ended with 'blocked', its report was never read: \.claude\/state\/marathon-reports\/ST-001\.json – go on with step 3, no new pass/);
  assert.doesNotMatch(r.out, /CONTINUE/);
  assert.equal(readState(dir).claims["ST-001"].attempts, 1);

  // A commit after the report: the report is stale, the pass was cut off – a continuation, counted apart.
  build(dir, "ST-001", "2");
  const again = ok(ms(dir, ["resume"], { now: T2 }));
  assert.match(again.out, /CONTINUE {5}ST-001 on st-001-demo – orphaned claim; start a story-worker continuation \(pass 2\)/);
  const claim = readState(dir).claims["ST-001"];
  assert.deepEqual([claim.attempts, claim.resumed], [2, 1]);
  assert.equal(readState(dir).consecutiveFailures, 0, "a cut-off is no failure of the story");
  ok(ms(dir, ["escalate", "ST-001", "--reason", "a decision is missing"]));
  assert.match(ok(ms(dir, ["summary"])).stdout, /branch `st-001-demo` \(local, not merged\) · 2 \(1 after a cut-off\) pass\(es\)/);
});
