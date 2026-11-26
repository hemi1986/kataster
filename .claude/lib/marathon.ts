/**
 * The write side of a marathon run: the lock and the atomic write of `.claude/state/marathon.json`, the transitions
 * of a run (`marathon-state.ts` is their only caller) and the decisions an orchestrator would otherwise make from
 * memory – when the run stops, what an orphaned claim becomes, what follows a review.
 *
 * The decisions are pure: they take the state and the facts and return the next state. Reading git, the last
 * `verify.ts` run and the story metrics happens in the functions at the end of this file, so the logic is testable
 * without a repository and without an agent.
 *
 * Read side and planning: `readMarathonState()` and `planWave()` in engineering.ts.
 * Harness-neutral: Claude Code and OpenCode run the same script against the same file.
 */
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import * as d from "./discovery.ts";
import * as e from "./engineering.ts";
import { changedPaths, gitRaw, isMetricsPath } from "./git.ts";
import { type KeptReport, type Lease, LEASE_FILE, readLease, reportFile, REPORTS_DIR } from "./lease.ts";
import { blockerHits, describeHit } from "./merge-blockers.ts";
import type { Entry, MetricsFile, ReviewRecord, ReviewVerdict } from "./metrics.ts";
import { REVIEW_VERDICTS, totalTokens } from "./metrics.ts";
import type { WorkerFacts } from "./worker.ts";

// --------------------------------------------------------------------------
// Vocabulary
// --------------------------------------------------------------------------
export const DEFAULT_LIMITS: e.MarathonLimits = { maxStories: 6, maxFailures: 3, gateFoundation: true, budgetTokens: null, budgetUsd: null };
/** A second `not accepted` ends the story: it is escalated instead of fixed a third time. */
export const MAX_NOT_ACCEPTED = 2;
/** A second pass that ends without a result ends the story as well. */
export const MAX_FAILED_PASSES = 2;
/** Foundation tasks – what the foundation gate waits for. */
export const FOUNDATION_TYPE = "tech-task";
/**
 * Paths an orchestrator writes after the merge; they do not make a green verify stale. `AGENTS.md` is in it for the
 * generated repository block that `repo-map.ts` rewrites with the map.
 */
export const isBookkeepingPath = (path: string): boolean => path.startsWith("docs/") || path === "CONTEXT.md" || path === "AGENTS.md";
/**
 * Story types whose merge needs an accepting `acceptance-tester` review – the lanes of `/implement`: domain stories
 * and tech tasks take the full lane, a spike's checklist evidence is checked too. Only `chore` and `task` are fast.
 */
export const ACCEPTANCE_TYPES = new Set(["domain", "story", "tech-task", "spike"]);
const ACCEPTING = new Set(["accepted", "accepted-with-remarks"]);

/** The command failed for a reason the caller can fix (exit 1). */
export class MarathonError extends Error {}
/** The run has to end: a limit, the budget, a red verify, the foundation gate or an empty plan (exit 3). */
export class MarathonStop extends Error {}

// --------------------------------------------------------------------------
// Lock and atomic write
// --------------------------------------------------------------------------
const sleep = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

export interface LockOptions {
  /** How long to wait for a lock another writer holds. */
  waitMs?: number;
  /** A lock older than this belongs to a writer that hangs or died on another host. */
  staleMs?: number;
  warn?: (message: string) => void;
}

/** Why the lock file is stale, or null while its writer may still be at work. */
function staleReason(lock: string, staleMs: number): { reason: string; content: string } | null {
  let content: string;
  let age: number;
  try {
    content = readFileSync(lock, "utf8");
    age = Date.now() - statSync(lock).mtimeMs;
  } catch {
    return null; // gone in the meantime – the next attempt takes it
  }
  let holder: { pid?: unknown; host?: unknown; at?: unknown } | null = null;
  try {
    holder = JSON.parse(content);
  } catch {
    // a writer died between creating the file and writing who it is
    return age > 2000 ? { reason: "no holder recorded", content } : null;
  }
  const who = `pid ${String(holder?.pid ?? "?")}, since ${String(holder?.at ?? "?")}`;
  if (holder?.host === hostname() && Number.isInteger(holder?.pid)) {
    try {
      process.kill(holder.pid as number, 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ESRCH") return { reason: `${who} – that process is gone`, content };
    }
  }
  return age > staleMs ? { reason: `${who} – held for ${Math.round(age / 1000)} s`, content } : null;
}

/**
 * Takes `<path>.lock` and returns the function that gives it back. The lock file is created exclusively and names
 * its holder; a lock whose process is gone, or that is older than `staleMs`, is broken with a warning. A live lock
 * is waited for; when it does not go away the call fails rather than write next to another writer.
 */
export function acquireLock(path: string, opts: LockOptions = {}): () => void {
  const waitMs = opts.waitMs ?? Number(process.env.KATASTER_MARATHON_LOCK_WAIT_MS ?? 10_000);
  const staleMs = opts.staleMs ?? 60_000;
  const warn = opts.warn ?? ((m: string) => console.error(`⚠ ${m}`));
  const lock = `${path}.lock`;
  mkdirSync(dirname(lock), { recursive: true });
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const fd = openSync(lock, "wx");
      try {
        writeFileSync(fd, JSON.stringify({ pid: process.pid, host: hostname(), at: new Date().toISOString() }));
      } finally {
        closeSync(fd);
      }
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const stale = staleReason(lock, staleMs);
      if (stale) {
        // Break only the lock that was judged: another process may have replaced it since.
        let still = false;
        try {
          still = readFileSync(lock, "utf8") === stale.content;
        } catch {
          // gone already
        }
        if (still) {
          warn(`stale lock ${d.rel(lock)} (${stale.reason}) – broken`);
          rmSync(lock, { force: true });
        }
        continue;
      }
      if (Date.now() > deadline) {
        throw new MarathonError(`${d.rel(path)} is locked by another writer – try again, or remove ${d.rel(lock)} when no marathon-state.ts is running`);
      }
      sleep(25);
    }
  }
  let held = true;
  const release = (): void => {
    if (!held) return;
    held = false;
    rmSync(lock, { force: true });
    process.off("exit", release);
  };
  // A command that exits while it holds the lock must not leave it behind for the next one to break.
  process.on("exit", release);
  return release;
}

/** Runs `fn` while holding `<path>.lock`. */
export function withStateLock<T>(path: string, fn: () => T, opts: LockOptions = {}): T {
  const release = acquireLock(path, opts);
  try {
    return fn();
  } finally {
    release();
  }
}

/** Atomic JSON write: a temp file in the same directory, then a rename. */
function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

/** Reads, changes and writes the lease under its own lock (always taken after the state's lock, never before). */
export function updateLease(change: (lease: Lease | null) => Lease, path = LEASE_FILE): Lease {
  return withStateLock(path, () => {
    const next = change(readLease(path));
    writeJson(path, next);
    return next;
  });
}

/** Keeps a worker's report for the run: a resumed orchestrator reads it instead of starting another pass. */
export function keepReport(report: KeptReport, dir = REPORTS_DIR): string {
  const file = reportFile(report.story, dir);
  writeJson(file, report);
  return file;
}

/** Validates and writes the state: a temp file in the same directory, then a rename – never a half-written file. */
export function writeMarathonState(state: e.MarathonState, path = e.MARATHON_STATE_FILE): void {
  const errs = e.marathonStateErrors(state);
  if (errs.length) throw new Error(`refusing to write an invalid marathon state:\n  - ${errs.join("\n  - ")}`);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

/** Where a finished run's state is kept once the next run starts. */
export const archiveFile = (run: string, path = e.MARATHON_STATE_FILE): string => join(dirname(path), "marathon", `${run}.json`);

// --------------------------------------------------------------------------
// Start
// --------------------------------------------------------------------------
/** Run ID and integration branch for a day: `2026-11-26` → `marathon/2026-11-26`, a second run of the day gets `-2`. */
export function runName(now: Date, taken: (branch: string) => boolean): { run: string; branch: string } {
  const pad = (n: number): string => String(n).padStart(2, "0");
  const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  for (let i = 1; ; i += 1) {
    const run = i === 1 ? day : `${day}-${i}`;
    if (!taken(`marathon/${run}`)) return { run, branch: `marathon/${run}` };
  }
}

export function newRun(opts: { run: string; branch: string; base: string; now: string; limits?: Partial<e.MarathonLimits> }): e.MarathonState {
  return {
    version: 1,
    run: opts.run,
    integrationBranch: opts.branch,
    base: opts.base,
    status: "running",
    startedAt: opts.now,
    limits: { ...DEFAULT_LIMITS, ...opts.limits },
    consecutiveFailures: 0,
    claims: {},
    results: {},
    escalations: [],
  };
}

// --------------------------------------------------------------------------
// Counting and stopping
// --------------------------------------------------------------------------
/** Every story the run has taken at least once. */
export function startedStories(state: e.MarathonState): string[] {
  return [...new Set([...Object.keys(state.results), ...state.escalations.map((x) => x.story), ...Object.keys(state.claims)])].sort();
}

export function runCounts(state: e.MarathonState): { started: number; merged: number; failed: number; escalated: number; claimed: number } {
  const escalated = new Set(state.escalations.map((x) => x.story));
  const outcomes = Object.entries(state.results).filter(([id]) => !escalated.has(id) && !(id in state.claims));
  return {
    started: startedStories(state).length,
    merged: outcomes.filter(([, r]) => r.outcome === "merged").length,
    failed: outcomes.filter(([, r]) => r.outcome === "failed").length,
    escalated: escalated.size,
    claimed: Object.keys(state.claims).length,
  };
}

/** What the run's stories have used since it started, from the story metrics. */
export interface RunUsage {
  tokens: number;
  /** null when a model has no price in `metrics.prices`. */
  costUsd: number | null;
  unpriced: string[];
}

export interface StopFacts {
  /** The story that would start next (ID and type), or null when the plan is empty. */
  next: { id: string; type: string } | null;
  /** Why the plan is empty. */
  planReason: string | null;
  /** The last `verify.ts` run. */
  verify: Pick<e.VerifyState, "branch" | "ok" | "steps"> | null;
  /** null when no budget is set and the usage was not read. */
  usage: RunUsage | null;
}

const stories = (n: number): string => `${n} ${n === 1 ? "story" : "stories"}`;
const fmtTokens = (n: number): string => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(Math.round(n)));

/**
 * Why no further story may start, or null when the next one may. Checked in this order: a red verify on the
 * integration branch, the failures in a row, the budget, the story limit, the foundation gate, an empty plan.
 * A story that is claimed already is finished whatever this says – the limits stop the run between stories.
 */
export function stopReason(state: e.MarathonState, f: StopFacts): string | null {
  const l = state.limits;
  if (f.verify && f.verify.branch === state.integrationBranch && !f.verify.ok) {
    const failed = f.verify.steps.filter((s) => !s.ok).map((s) => s.name);
    return `verify is red on ${state.integrationBranch}${failed.length ? ` (${failed.join(", ")})` : ""} – a marathon stops there and repairs nothing`;
  }
  if (state.consecutiveFailures >= l.maxFailures) {
    return `${stories(state.consecutiveFailures)} in a row ended without a merge (limit ${l.maxFailures})`;
  }
  if (f.usage) {
    if (l.budgetTokens !== null && f.usage.tokens >= l.budgetTokens) {
      return `the token budget is used up: ${fmtTokens(f.usage.tokens)} of ${fmtTokens(l.budgetTokens)}`;
    }
    if (l.budgetUsd !== null) {
      if (f.usage.costUsd === null) {
        return `the cost budget cannot be checked: no price in metrics.prices for ${f.usage.unpriced.join(", ") || "a model"}`;
      }
      if (f.usage.costUsd >= l.budgetUsd) return `the cost budget is used up: $${f.usage.costUsd.toFixed(2)} of $${l.budgetUsd.toFixed(2)}`;
    }
  }
  if (!f.next) return f.planReason ?? "no story is planned";
  const started = startedStories(state);
  if (!started.includes(f.next.id) && started.length >= l.maxStories) return `the run has started ${stories(started.length)} (limit ${l.maxStories})`;
  if (l.gateFoundation && f.next.type !== FOUNDATION_TYPE) {
    const foundation = Object.entries(state.results).filter(([, r]) => r.outcome === "merged" && r.type === FOUNDATION_TYPE).map(([id]) => id);
    if (foundation.length) {
      return `foundation gate: ${foundation.join(", ")} merged and ${f.next.id} is no foundation task – the user reviews the foundation (and the engineering conventions) before the next stories build on it`;
    }
  }
  return null;
}

// --------------------------------------------------------------------------
// Transitions – pure: (state, facts) → next state
// --------------------------------------------------------------------------
const clone = (state: e.MarathonState): e.MarathonState => structuredClone(state);

function running(state: e.MarathonState): void {
  if (state.status !== "running") {
    throw new MarathonError(`run ${state.run} is finished (${state.stop?.reason ?? "no reason recorded"}) – start a new run`);
  }
}

function claimOf(state: e.MarathonState, id: string): e.MarathonClaim {
  const claim = state.claims[id];
  if (!claim) {
    const held = Object.keys(state.claims);
    throw new MarathonError(`${id} is not claimed${held.length ? ` (open claim: ${held.join(", ")})` : ""}`);
  }
  return claim;
}

/** Throws unless the run can take `id` now. Serial: one open claim at a time. */
export function assertClaimable(state: e.MarathonState, id: string): void {
  running(state);
  const held = Object.keys(state.claims);
  if (held.includes(id)) throw new MarathonError(`${id} is claimed already – a further pass on it is \`claim ${id} --continue\``);
  if (held.length) throw new MarathonError(`${held.join(", ")} is still claimed – a serial run holds one story at a time`);
}

/** Takes a story for its first pass of this claim. */
export function applyClaim(state: e.MarathonState, story: { id: string; branch: string; type: string }, now: string): e.MarathonState {
  assertClaimable(state, story.id);
  const next = clone(state);
  next.claims[story.id] = {
    branch: story.branch,
    start: now,
    attempts: (state.results[story.id]?.attempts ?? 0) + 1,
    type: story.type,
    phase: "worker",
    passStart: now,
    reviews: [],
  };
  return next;
}

/** A further worker pass on a claimed story: after review findings, or to go on with a pass that was cut off. */
export function applyContinue(state: e.MarathonState, id: string, now: string): e.MarathonState {
  running(state);
  claimOf(state, id);
  const next = clone(state);
  const claim = next.claims[id];
  claim.attempts += 1;
  claim.phase = "worker";
  claim.passStart = now;
  return next;
}

/** Gives a claim back as if it had not been taken: no result, the attempt does not count. */
export function applyRelease(state: e.MarathonState, id: string): e.MarathonState {
  claimOf(state, id);
  const next = clone(state);
  delete next.claims[id];
  return next;
}

export interface Details {
  openQuestions: e.MarathonQuestion[];
  decisions: e.MarathonDecision[];
  notes: string[];
}

const DETAIL_KEYS = ["openQuestions", "decisions", "notes"];

/**
 * What goes into the run's summary besides the reason:
 * `{ "openQuestions": [{ question, kind }], "decisions": [{ question, decision, why }], "notes": ["…"] }`.
 * A worker report is accepted as it is – its `openQuestions` and `decisions` are taken, the rest is in git.
 */
export function parseDetails(raw: unknown): { details: Details; errors: string[] } {
  const details: Details = { openQuestions: [], decisions: [], notes: [] };
  const errors: string[] = [];
  if (raw === undefined || raw === null) return { details, errors };
  if (typeof raw !== "object" || Array.isArray(raw)) return { details, errors: ["the details must be a JSON object"] };
  const obj = raw as Record<string, unknown>;
  const isReport = obj.report === "implement-worker";
  if (!isReport) for (const key of Object.keys(obj)) if (!DETAIL_KEYS.includes(key)) errors.push(`unknown key '${key}' (allowed: ${DETAIL_KEYS.join(", ")} – or a whole worker report)`);
  const str = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
  if (obj.decisions !== undefined) {
    if (!Array.isArray(obj.decisions)) errors.push("decisions must be a list");
    else {
      obj.decisions.forEach((x, i) => {
        const item = x as Record<string, unknown> | null;
        if (!item || typeof item !== "object" || !str(item.question) || !str(item.decision) || !str(item.why)) errors.push(`decisions[${i}] needs question, decision and why`);
        else details.decisions.push({ question: item.question.trim(), decision: item.decision.trim(), why: item.why.trim() });
      });
    }
  }
  if (obj.openQuestions !== undefined) {
    if (!Array.isArray(obj.openQuestions)) errors.push("openQuestions must be a list");
    else {
      obj.openQuestions.forEach((q, i) => {
        const item = q as Record<string, unknown> | null;
        if (!item || typeof item !== "object" || !str(item.question)) errors.push(`openQuestions[${i}] needs question`);
        else details.openQuestions.push({ question: item.question.trim(), kind: str(item.kind) ? item.kind : "technical" });
      });
    }
  }
  if (!isReport && obj.notes !== undefined) {
    if (!Array.isArray(obj.notes) || !obj.notes.every(str)) errors.push("notes must be a list of strings");
    else details.notes = (obj.notes as string[]).map((x) => x.trim());
  }
  return { details, errors };
}

const extras = (claim: e.MarathonClaim, details: Details): Pick<e.MarathonResult, "resumed" | "type" | "reviews" | "openQuestions" | "decisions" | "notes"> => ({
  ...(claim.resumed ? { resumed: claim.resumed } : {}),
  ...(claim.type ? { type: claim.type } : {}),
  ...(claim.reviews?.length ? { reviews: claim.reviews } : {}),
  ...(details.openQuestions.length ? { openQuestions: details.openQuestions } : {}),
  ...(details.decisions?.length ? { decisions: details.decisions } : {}),
  ...(details.notes.length ? { notes: details.notes } : {}),
});

/** Facts `result … merged` is checked against. */
export interface MergeFacts {
  current: string | null;
  /** Uncommitted paths that are not collected metrics. */
  dirty: string[];
  /** The story's status in the checkout. */
  storyStatus: string | null;
  branchExists: boolean;
  /** The story branch's head is in the integration branch. */
  branchMerged: boolean;
  verify: (Pick<e.VerifyState, "branch" | "ok" | "commit" | "dirty"> & { failed: string[] }) | null;
  /** `verify.commit` is on the integration branch and contains the story branch. */
  verifyCoversMerge: boolean;
  /** Paths changed since `verify.commit` that are not bookkeeping (docs, glossary). */
  changedSinceVerify: string[];
  /** The checked-in repository map no longer matches the repository; null when the project has no map. */
  repoMapStale?: boolean | null;
}

/** Why the story is not merged as far as git and the last verify run can tell; empty means `merged` may be recorded. */
export function mergeErrors(state: e.MarathonState, id: string, claim: e.MarathonClaim, f: MergeFacts, details?: Details): string[] {
  const errs: string[] = [];
  const branch = state.integrationBranch;
  if (f.current !== branch) errs.push(`the checkout is on '${f.current ?? "?"}', not on the integration branch '${branch}'`);
  if (!f.branchExists) errs.push(`the story branch '${claim.branch}' does not exist`);
  else if (!f.branchMerged) errs.push(`'${claim.branch}' is not merged into '${branch}' – git merge --no-ff ${claim.branch}`);
  if (!f.verify || f.verify.branch !== branch) errs.push(`verify.ts has not run on '${branch}' after the merge`);
  else if (!f.verify.ok) errs.push(`verify.ts is red on '${branch}' (${f.verify.failed.join(", ")}) – record \`result ${id} failed\`; the run stops`);
  else if (f.verify.dirty || !f.verifyCoversMerge) errs.push(`the last verify.ts run on '${branch}' was before the merge of '${claim.branch}' or on uncommitted code – run it again`);
  else if (f.changedSinceVerify.length) {
    errs.push(`code changed after the green verify (${f.changedSinceVerify.slice(0, 5).join(", ")}${f.changedSinceVerify.length > 5 ? ", …" : ""}) – run verify.ts again`);
  }
  if (f.storyStatus !== "done") errs.push(`the story is '${f.storyStatus ?? "?"}', not 'done' – after the merge: story-status.ts ${id} done`);
  if (ACCEPTANCE_TYPES.has(claim.type ?? "domain") && !(claim.reviews ?? []).some((r) => r.agent === "acceptance-tester" && ACCEPTING.has(r.verdict))) {
    errs.push(
      `a ${claim.type ?? "domain"} story is merged only after the acceptance-tester accepted it – no accepting review is recorded. ` +
        "The fast lane is for chore and task; run the reviews (step 4) and record them with `marathon-state.ts review`",
    );
  }
  errs.push(...mergeBlockerErrors(id, claim, details));
  if (f.repoMapStale) errs.push("the repository map is stale after the merge – run `node .claude/skills/adopt/scripts/repo-map.ts` and commit it with the bookkeeping");
  if (f.dirty.length) errs.push(`uncommitted changes: ${f.dirty.slice(0, 5).join(", ")}${f.dirty.length > 5 ? ", …" : ""} – commit them as '${id}: done'`);
  return errs;
}

/**
 * Merge blockers (`lib/merge-blockers.ts`) are never merged: not open in a reviewer's last review, and not in the
 * merge's details disguised as a decision or an open question. Either way the way out is a fix pass and the
 * reviewer again – and when the blocker survives that, the escalation.
 */
export function mergeBlockerErrors(id: string, claim: e.MarathonClaim, details?: Details): string[] {
  const errs: string[] = [];
  const latest = new Map<string, e.MarathonReview>();
  for (const r of claim.reviews ?? []) latest.set(r.agent, r);
  for (const [agent, r] of latest) {
    if ((r.mergeBlocker ?? 0) > 0) {
      errs.push(
        `${agent}'s last review has ${r.mergeBlocker} merge blocker(s) – they are never merged: a fix pass ` +
          `(claim ${id} --continue), then ${agent} again; still there → escalate`,
      );
    }
  }
  if (details) {
    for (const hit of blockerHits({ decisions: details.decisions, openQuestions: details.openQuestions })) {
      errs.push(
        `${describeHit(hit)} – a merge blocker is never merged as a decision or an open question: a fix pass with it ` +
          `(claim ${id} --continue), then the reviewer again; still open after that → escalate`,
      );
    }
  }
  return errs;
}

/** The story is in the integration branch and `done` there. Ends the claim and the series of failures. */
export function applyMerged(state: e.MarathonState, id: string, details: Details, now: string): e.MarathonState {
  running(state);
  const claim = claimOf(state, id);
  const next = clone(state);
  delete next.claims[id];
  next.results[id] = { outcome: "merged", at: now, branch: claim.branch, attempts: claim.attempts, ...extras(claim, details) };
  next.consecutiveFailures = 0;
  return next;
}

function escalation(id: string, claim: e.MarathonClaim, reason: string, details: Details, now: string): e.MarathonEscalation {
  return { story: id, reason, at: now, branch: claim.branch, attempts: claim.attempts, ...extras(claim, details) };
}

/**
 * A pass ended without a result. The story may be planned once more; its second failure escalates it, so a story
 * that keeps failing does not eat the run.
 */
export function applyFailed(state: e.MarathonState, id: string, reason: string, details: Details, now: string): { state: e.MarathonState; escalated: boolean } {
  running(state);
  const claim = claimOf(state, id);
  const next = clone(state);
  delete next.claims[id];
  const failures = (state.results[id]?.outcome === "failed" ? (state.results[id].failures ?? 1) : 0) + 1;
  next.results[id] = { outcome: "failed", at: now, branch: claim.branch, attempts: claim.attempts, reason, failures, ...extras(claim, details) };
  next.consecutiveFailures += 1;
  const escalated = failures >= MAX_FAILED_PASSES;
  if (escalated) next.escalations.push(escalation(id, claim, `failed ${failures} times – last: ${reason}`, details, now));
  return { state: next, escalated };
}

/**
 * The run gives the story up: it waits for the user with its reason and is not planned again in this run.
 * `branchExists: false` – the story was given up before a worker cut its branch – leaves the branch out.
 */
export function applyEscalate(state: e.MarathonState, id: string, reason: string, details: Details, now: string, branchExists = true): e.MarathonState {
  running(state);
  const claim = claimOf(state, id);
  const next = clone(state);
  delete next.claims[id];
  const entry = escalation(id, claim, reason, details, now);
  if (!branchExists) delete entry.branch;
  next.escalations.push(entry);
  next.consecutiveFailures += 1;
  return next;
}

// --------------------------------------------------------------------------
// Reviews
// --------------------------------------------------------------------------
export interface ReviewInput {
  agent: string;
  verdict: ReviewVerdict;
  blocker: number;
  major: number;
  minor: number;
  question: number;
  /** Findings of the merge-blocker kinds (`lib/merge-blockers.ts`), whatever severity the reviewer gave them. */
  mergeBlocker: number;
}

const blocks = (r: e.MarathonReview): boolean => (r.mergeBlocker ?? 0) > 0;
const needsFixes = (r: e.MarathonReview): boolean =>
  r.verdict === "not-accepted" || r.verdict === "fix-blockers-first" || r.blocker + r.major > 0 || blocks(r);

/**
 * What follows the reviews of the current round (the reviews since the last worker pass started):
 *   escalate – the story was `not accepted` twice, or a reviewer reports a merge blocker again after the fix pass
 *              for its last one; a further round is the user's decision (`reason` says which)
 *   fixes    – a reviewer does not accept, there are blockers or majors, or a merge blocker: a worker pass with the
 *              findings. `again` names the reviewers who run again before the merge – the acceptance tester when it
 *              did not accept, every reviewer who reported a merge blocker; `then` is `acceptance` when that is the
 *              acceptance tester alone, `review` for more, `merge` for none
 *   merge    – nothing a worker has to fix; minors and questions are the orchestrator's call
 */
export interface ReviewNext {
  action: "escalate" | "fixes" | "merge";
  then: "acceptance" | "review" | "merge" | null;
  /** Reviewers who review again after the fix pass, before the merge. */
  again: string[];
  /** Why the story escalates; null otherwise. */
  reason: "not-accepted" | "merge-blocker" | null;
  notAccepted: number;
  /** Findings of the round, summed over its reviewers. */
  round: { blocker: number; major: number; minor: number; question: number; mergeBlocker: number };
}

export function reviewNext(claim: e.MarathonClaim): ReviewNext {
  const all = claim.reviews ?? [];
  const since = claim.passStart ?? claim.start;
  const round = all.filter((r) => r.at >= since);
  const sum = { blocker: 0, major: 0, minor: 0, question: 0, mergeBlocker: 0 };
  for (const r of round) {
    for (const k of ["blocker", "major", "minor", "question"] as const) sum[k] += r[k];
    sum.mergeBlocker += r.mergeBlocker ?? 0;
  }
  const notAccepted = all.filter((r) => r.verdict === "not-accepted").length;
  const base = { again: [] as string[], notAccepted, round: sum };
  // One fix pass per merge blocker: a reviewer who reported one and, after the fix pass, reports one again → the user
  // decides. A reviewer's first merge blocker in a later round still gets its fix pass.
  const before = (agent: string) => all.filter((r) => r.agent === agent && r.at < since).at(-1);
  if (round.some((r) => blocks(r) && before(r.agent) && blocks(before(r.agent)!))) return { ...base, action: "escalate", then: null, reason: "merge-blocker" };
  if (notAccepted >= MAX_NOT_ACCEPTED) return { ...base, action: "escalate", then: null, reason: "not-accepted" };
  if (round.some(needsFixes)) {
    const again = [...new Set(round.filter((r) => r.verdict === "not-accepted" || blocks(r)).map((r) => r.agent))];
    const then = !again.length ? "merge" : again.length === 1 && again[0] === "acceptance-tester" ? "acceptance" : "review";
    return { ...base, action: "fixes", then, again, reason: null };
  }
  return { ...base, action: "merge", then: null, reason: null };
}

/** Records a review on the claim and moves the claim to where the round now stands. */
export function applyReview(state: e.MarathonState, id: string, review: ReviewInput, now: string): { state: e.MarathonState; next: ReviewNext } {
  running(state);
  claimOf(state, id);
  if (!(REVIEW_VERDICTS as readonly string[]).includes(review.verdict)) throw new MarathonError(`'${review.verdict}' is not a verdict (${REVIEW_VERDICTS.join(", ")})`);
  const state2 = clone(state);
  const claim = state2.claims[id];
  claim.reviews = [...(claim.reviews ?? []), { ...review, at: now }];
  const next = reviewNext(claim);
  claim.phase = next.action === "merge" ? "merge" : "review";
  return { state: state2, next };
}

// --------------------------------------------------------------------------
// Resume
// --------------------------------------------------------------------------
/** What git says about a claimed story when a run starts or resumes. */
export interface ClaimFacts {
  branchExists: boolean;
  /** The story branch is in the integration branch and the story is `in-progress` or `done` there. */
  merged: boolean;
  /**
   * The worker of the current pass handed in its report, and the branch head is still the one it reported on: the
   * pass ended – only the orchestrator that should have read the report was cut off.
   */
  reported?: boolean;
}

/**
 * What an open claim becomes when a run starts or resumes. A claim whose worker is not running is orphaned:
 *   keep     – the orchestrator says its worker is still running
 *   release  – no story branch: nothing was built, the story goes back into the plan
 *   merge    – the branch is merged already, or the reviews accepted it: go on with the merge step, no worker pass
 *   report   – the pass ended with a report the orchestrator never read: read it (step 3), no worker pass
 *   continue – the branch exists: a worker continues on it; the pass counts as a pass, not as a failure
 */
export type OrphanAction = "keep" | "release" | "merge" | "report" | "continue";

export function orphanAction(claim: e.MarathonClaim, f: ClaimFacts, workerRunning: boolean): OrphanAction {
  if (workerRunning) return "keep";
  if (!f.branchExists) return "release";
  if (f.merged || claim.phase === "merge") return "merge";
  if (f.reported && (claim.phase ?? "worker") === "worker") return "report";
  return "continue";
}

/** Whether the kept report is the report of the claim's current pass, made on the branch head as it is now. */
export function reportCovers(kept: KeptReport | null, run: string, claim: e.MarathonClaim, head: string | null): boolean {
  return !!kept && kept.run === run && kept.pass === claim.attempts && !!head && kept.head === head;
}

export function applyResume(
  state: e.MarathonState,
  facts: Record<string, ClaimFacts>,
  runningWorkers: string[],
  now: string,
): { state: e.MarathonState; actions: { story: string; action: OrphanAction; branch: string; attempts: number }[] } {
  running(state);
  for (const id of runningWorkers) claimOf(state, id);
  const next = clone(state);
  const actions: { story: string; action: OrphanAction; branch: string; attempts: number }[] = [];
  for (const [id, claim] of Object.entries(state.claims)) {
    const action = orphanAction(claim, facts[id] ?? { branchExists: false, merged: false }, runningWorkers.includes(id));
    if (action === "release") delete next.claims[id];
    if (action === "continue") {
      next.claims[id].attempts += 1;
      next.claims[id].resumed = (claim.resumed ?? 0) + 1;
      next.claims[id].phase = "worker";
      next.claims[id].passStart = now;
    }
    if (action === "merge") next.claims[id].phase = "merge";
    actions.push({ story: id, action, branch: claim.branch, attempts: next.claims[id]?.attempts ?? claim.attempts });
  }
  return { state: next, actions };
}

// --------------------------------------------------------------------------
// Finish
// --------------------------------------------------------------------------
/** Ends the run with its reason; called again with the pull request once that is open. */
export function applyFinish(state: e.MarathonState, opts: { reason?: string; pr?: string }, now: string): e.MarathonState {
  const next = clone(state);
  if (state.status === "finished") {
    if (!opts.pr) throw new MarathonError(`run ${state.run} is finished already (${state.stop?.reason ?? ""}) – pass --pr <url> to record its pull request`);
    next.stop = { reason: state.stop?.reason ?? "", at: state.stop?.at ?? now, pr: opts.pr };
    return next;
  }
  const held = Object.keys(state.claims);
  if (held.length) throw new MarathonError(`${held.join(", ")} is still claimed – merge, escalate or release it before the run ends`);
  if (!opts.reason) throw new MarathonError("the run has no reason to stop yet – pass --reason (e.g. the user ended it)");
  next.status = "finished";
  next.stop = { reason: opts.reason, at: now, pr: opts.pr ?? null };
  return next;
}

// --------------------------------------------------------------------------
// The next step – what `status` prints and a resumed orchestrator reads
// --------------------------------------------------------------------------
export type NextStep =
  | { action: "claim"; story: string }
  | { action: "work"; story: string; phase: e.MarathonPhase; branch: string }
  | { action: "stop"; reason: string }
  | { action: "open-pr"; reason: string }
  | { action: "none"; reason: string };

export function nextStep(state: e.MarathonState, f: StopFacts): NextStep {
  if (state.status === "finished") {
    const reason = state.stop?.reason ?? "";
    return state.stop?.pr ? { action: "none", reason: `finished (${reason}) – ${state.stop.pr}` } : { action: "open-pr", reason };
  }
  const [held] = Object.entries(state.claims);
  if (held) return { action: "work", story: held[0], phase: held[1].phase ?? "worker", branch: held[1].branch };
  const stop = stopReason(state, f);
  if (stop) return { action: "stop", reason: stop };
  return { action: "claim", story: f.next!.id };
}

// --------------------------------------------------------------------------
// Summary – the body of the run's pull request
// --------------------------------------------------------------------------
const reviewLine = (reviews: e.MarathonReview[] | undefined): string =>
  (reviews ?? []).map((r) => `${r.agent}: ${r.verdict.replaceAll("-", " ")}${r.blocker + r.major + r.minor + r.question ? ` (${r.blocker}B ${r.major}M ${r.minor}m ${r.question}Q)` : ""}`).join("; ") || "–";
const cell = (v: string): string => v.replaceAll("|", "\\|").replaceAll("\n", " ");
const passes = (attempts: number | undefined, resumed: number | undefined): string => `${attempts ?? 0}${resumed ? ` (${resumed} after a cut-off)` : ""}`;

/**
 * The run as Markdown: what was merged, what was escalated and why, the open questions, the metrics. `metrics` is
 * the rendered metrics table of the run's stories (or a line saying why there is none).
 */
export function renderSummary(state: e.MarathonState, titles: Map<string, string>, metrics: string): string {
  const c = runCounts(state);
  const title = (id: string): string => titles.get(id) ?? "";
  const escalated = new Set(state.escalations.map((x) => x.story));
  const out: string[] = [`# Marathon ${state.run}`, ""];
  out.push(
    `\`${state.integrationBranch}\` → \`${state.base}\` · started ${state.startedAt.slice(0, 16).replace("T", " ")} UTC · ` +
      `**${c.merged} merged**, ${c.escalated} escalated, ${c.failed} failed${c.claimed ? `, ${c.claimed} still claimed` : ""}`,
    "",
    `**Why the run ended:** ${state.stop?.reason ?? "it is still running"}`,
    "",
  );

  const merged = Object.entries(state.results).filter(([, r]) => r.outcome === "merged");
  out.push("## Merged", "");
  if (!merged.length) out.push("None.", "");
  else {
    out.push("| Story | Title | Type | Passes | Reviews |", "|---|---|---|---:|---|");
    for (const [id, r] of merged) out.push(`| ${id} | ${cell(title(id))} | ${r.type ?? "–"} | ${passes(r.attempts, r.resumed)} | ${cell(reviewLine(r.reviews))} |`);
    out.push("");
    for (const [id, r] of merged) for (const note of r.notes ?? []) out.push(`- ${id}: ${note}`);
    if (merged.some(([, r]) => r.notes?.length)) out.push("");
  }

  out.push("## Escalations", "");
  if (!state.escalations.length) out.push("None.", "");
  for (const x of state.escalations) {
    out.push(`- **${x.story}${title(x.story) ? ` – ${title(x.story)}` : ""}** – ${x.reason}`);
    out.push(`  - ${x.branch ? `branch \`${x.branch}\` (local, not merged)` : "no branch"} · ${passes(x.attempts, x.resumed)} pass(es) · reviews: ${reviewLine(x.reviews)}`);
    for (const note of x.notes ?? []) out.push(`  - ${note}`);
  }
  if (state.escalations.length) out.push("");

  const failed = Object.entries(state.results).filter(([id, r]) => r.outcome === "failed" && !escalated.has(id));
  if (failed.length) {
    out.push("## Failed passes", "");
    for (const [id, r] of failed) out.push(`- **${id}${title(id) ? ` – ${title(id)}` : ""}** – ${r.reason ?? "no reason recorded"} (branch \`${r.branch ?? "?"}\`)`);
    out.push("");
  }

  const questions: { story: string; q: e.MarathonQuestion }[] = [
    ...state.escalations.flatMap((x) => (x.openQuestions ?? []).map((q) => ({ story: x.story, q }))),
    ...Object.entries(state.results).filter(([id]) => !escalated.has(id)).flatMap(([id, r]) => (r.openQuestions ?? []).map((q) => ({ story: id, q }))),
  ];
  out.push("## Open questions", "");
  if (!questions.length) out.push("None.", "");
  else {
    for (const { story, q } of questions) out.push(`- **${story}** (${q.kind}): ${q.question}`);
    out.push("");
  }

  // Technical details a worker settled with a default instead of blocking – merged, waiting for the user's nod.
  const decided: { story: string; x: e.MarathonDecision }[] = [
    ...Object.entries(state.results).filter(([, r]) => r.outcome === "merged").flatMap(([id, r]) => (r.decisions ?? []).map((x) => ({ story: id, x }))),
    ...state.escalations.flatMap((s) => (s.decisions ?? []).map((x) => ({ story: s.story, x }))),
  ];
  if (decided.length) {
    out.push("## Decided with a default – confirm or change", "");
    for (const { story, x } of decided) out.push(`- **${story}**: ${x.question} → **${x.decision}** – ${x.why}`);
    out.push("");
  }

  out.push("## Metrics", "", metrics.trim(), "");
  return out.join("\n");
}

// --------------------------------------------------------------------------
// Facts – git, the last verify run, the story metrics
// --------------------------------------------------------------------------
const git = (...args: string[]): string | null => gitRaw(d.ROOT, args)?.trim() ?? null;
const lines = (s: string | null): string[] => (s ?? "").split("\n").map((l) => l.trim()).filter(Boolean);

export const branchExists = (branch: string): boolean => git("rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`) !== null;
export const currentBranch = (): string | null => git("rev-parse", "--abbrev-ref", "HEAD");
/** Uncommitted paths that are work, not collected metrics. */
export const dirtyPaths = (): string[] => changedPaths(d.ROOT).filter((p) => !isMetricsPath(p));
const isAncestor = (a: string, b: string): boolean => gitRaw(d.ROOT, ["merge-base", "--is-ancestor", a, b]) !== null;

/** The default branch from the project profile; `main` when the profile does not name one. */
export function defaultBranch(): string {
  try {
    const profile = JSON.parse(readFileSync(join(d.ROOT, ".claude", "project.json"), "utf8"));
    return String(profile.repo?.defaultBranch || "main");
  } catch {
    return "main";
  }
}

/** A claim against git, from the worker facts of its story with the integration branch as the base. */
export function claimFacts(f: Pick<WorkerFacts, "branchExists" | "commits" | "baseStatus">): ClaimFacts {
  const merged = f.branchExists && !f.commits.length && (f.baseStatus === "in-progress" || f.baseStatus === "done");
  return { branchExists: f.branchExists, merged };
}

export function mergeFacts(state: e.MarathonState, claim: e.MarathonClaim, storyStatus: string | null): MergeFacts {
  const exists = branchExists(claim.branch);
  const v = e.readVerifyState();
  const target = `refs/heads/${state.integrationBranch}`;
  const covers = !!v?.commit && exists && isAncestor(claim.branch, v.commit) && isAncestor(v.commit, target);
  return {
    current: currentBranch(),
    dirty: dirtyPaths(),
    storyStatus,
    branchExists: exists,
    branchMerged: exists && isAncestor(claim.branch, target),
    verify: v ? { branch: v.branch, ok: v.ok, commit: v.commit, dirty: v.dirty, failed: v.steps.filter((s) => !s.ok).map((s) => s.name) } : null,
    verifyCoversMerge: covers,
    changedSinceVerify: covers ? lines(git("diff", "--name-only", v!.commit!, target)).filter((p) => !isBookkeepingPath(p)) : [],
    repoMapStale: repoMapStale(),
  };
}

/** Whether `docs/architecture/repo-map.json` is behind the repository; null when the project keeps no map. */
export function repoMapStale(root = d.ROOT): boolean | null {
  if (!existsSync(join(root, "docs", "architecture", "repo-map.json"))) return null;
  const script = join(root, ".claude", "skills", "adopt", "scripts", "repo-map.ts");
  if (!existsSync(script)) return null;
  const r = spawnSync(process.execPath, [script, "--check"], { cwd: root, encoding: "utf8" });
  return r.status !== 0;
}

/** The branches of the run's stories that are not merged – their metrics are not in the integration branch. */
function unmergedBranches(state: e.MarathonState): { story: string; branch: string }[] {
  const out = new Map<string, string>();
  for (const [id, c] of Object.entries(state.claims)) out.set(id, c.branch);
  for (const x of state.escalations) if (x.branch) out.set(x.story, x.branch);
  for (const [id, r] of Object.entries(state.results)) if (r.outcome === "failed" && r.branch) out.set(id, r.branch);
  return [...out].map(([story, branch]) => ({ story, branch }));
}

/** Metrics entries and reviews of stories whose branch is not merged, read from those branches. */
export function unmergedMetrics(state: e.MarathonState): { entries: Entry[]; reviews: { target: string; review: ReviewRecord }[] } {
  const entries: Entry[] = [];
  const reviews: { target: string; review: ReviewRecord }[] = [];
  for (const { story, branch } of unmergedBranches(state)) {
    const text = gitRaw(d.ROOT, ["show", `refs/heads/${branch}:docs/stories/metrics/${story}.json`]);
    if (text === null) continue;
    try {
      const file = JSON.parse(text) as MetricsFile;
      entries.push(...(file.entries ?? []));
      for (const review of file.reviews ?? []) reviews.push({ target: story, review });
    } catch {
      // a broken file on a branch does not stop the run; the report of that branch will say so
    }
  }
  return { entries, reviews };
}

/** Tokens and cost of the run's stories since the run started – own phases and their unassigned pot, no spec share. */
export async function runUsage(state: e.MarathonState): Promise<RunUsage & { report: import("./metrics-report.ts").ReportData }> {
  const { buildReport } = await import("./metrics-report.ts");
  const report = buildReport({ stories: startedStories(state), since: state.startedAt, extra: unmergedMetrics(state) });
  let tokens = 0;
  let costUsd: number | null = 0;
  for (const s of report.stories) {
    tokens += totalTokens(s.own.tokens) + totalTokens(s.unassigned.tokens);
    costUsd = costUsd === null || s.own.costUsd === null || s.unassigned.costUsd === null ? null : costUsd + s.own.costUsd + s.unassigned.costUsd;
  }
  return { tokens, costUsd, unpriced: report.unpriced, report };
}

/** Everything `stopReason` needs, read from the checkout. The usage is read only when a budget is set. */
export async function stopFacts(state: e.MarathonState, plan: e.WavePlan): Promise<StopFacts> {
  const first = plan.wave[0]?.story;
  const budget = state.limits.budgetTokens !== null || state.limits.budgetUsd !== null;
  return {
    next: first ? { id: d.storyId(first), type: String(first.meta.type ?? "") } : null,
    planReason: plan.reason,
    verify: e.readVerifyState(),
    usage: budget ? await runUsage(state) : null,
  };
}
