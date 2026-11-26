/**
 * The worker mode of `/implement` (`--worker ST-NNN --base <branch>`): the facts of a pass and the report a worker
 * hands back to its orchestrator.
 *
 * A worker never asks the user. What it would ask becomes a report, and everything in that report that git or the
 * last `verify.ts` run can tell is read here, not remembered by the model: branch, commits, changed files, the
 * verify result. The worker adds its judgement only – the result, the reason, new terms, ADR proposals, open
 * questions – and the result is checked against the facts before the report is printed.
 *
 * Harness-neutral: Claude Code and OpenCode run the same script (`implement/scripts/worker.ts`).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { loadBacklogConfig } from "./config.ts";
import * as d from "./discovery.ts";
import * as e from "./engineering.ts";
import { changedPaths, gitRaw, isMetricsPath } from "./git.ts";
import { blockerHits, describeHit } from "./merge-blockers.ts";

/**
 * How a pass ends. All three are equal outcomes – `blocked` is not a failure of the worker:
 *   ready-for-review    implemented, verify green on the branch head, nothing left open
 *   blocked             a precondition, a tool or a decision the story does not own stops the pass
 *   returned-to-review  the story itself is wrong; it carries `[OPEN]` and went back to `review` on the branch
 */
export const WORKER_RESULTS = ["ready-for-review", "blocked", "returned-to-review"] as const;
export type WorkerResult = (typeof WORKER_RESULTS)[number];

export type VerifyStatus = "green" | "red" | "stale" | "not-run";

export interface WorkerFacts {
  story: string;
  title: string | null;
  type: string | null;
  /** Status of the story file in the checkout (on the base when the checkout does not have it). */
  storyStatus: string | null;
  /** Status of the story on the base – what decides whether a first pass may start. */
  baseStatus: string | null;
  base: string;
  /** Commit the base resolves to, or null when it does not exist. */
  baseCommit: string | null;
  /** The story branch: the story's file name in lower case. */
  branch: string | null;
  branchExists: boolean;
  /** The branch that is checked out. */
  current: string | null;
  /** Head of the story branch. */
  head: string | null;
  /** Commits of the story branch that are not on the base, oldest first. */
  commits: { sha: string; subject: string }[];
  /** Files the story branch changed against the base. */
  changedFiles: string[];
  /** Uncommitted paths in the checkout. */
  uncommitted: string[];
  verify: { status: VerifyStatus; at: string | null; commit: string | null; failed: string[] };
  /** Review files of the story that exist in the checkout. */
  reviews: string[];
  /** The tracker the story must be linked to and is not; null when there is nothing to complain about. */
  unlinked: string | null;
  /**
   * What would stop `story-status.ts ST-NNN done` in this checkout: a scenario without its test, an unticked
   * checklist item. The orchestrator sets `done` after the merge – it must not find out there.
   */
  doneBlockers: string[];
}

const git = (...args: string[]): string | null => gitRaw(d.ROOT, args)?.trim() ?? null;
const lines = (s: string | null): string[] => (s ?? "").split("\n").map((l) => l.trim()).filter(Boolean);

/** A frontmatter value read with a regular expression – enough for a story file as it is on another ref. */
function frontValue(text: string, key: string): string | null {
  const front = text.replaceAll("\r\n", "\n").split("\n---")[0] ?? "";
  const m = new RegExp(`^${key}:\\s*(.+?)\\s*$`, "m").exec(front);
  return m ? m[1].replace(/^(["'])(.*)\1$/, "$2") : null;
}

function hasExternalKey(text: string): boolean {
  const front = text.replaceAll("\r\n", "\n").split("\n---")[0] ?? "";
  return /^external:.*\bkey:\s*["']?[^\s"'}]/m.test(front) || /^external:\s*\n(?:[ \t]+.*\n)*?[ \t]+key:\s*["']?[^\s"']/m.test(`${front}\n`);
}

/** The story file (`ST-NNN-<slug>.md`): from the checkout – committed or not – otherwise as it is on `ref`. */
function locateStory(id: string, ref: string | null): { path: string; text: string } | null {
  const named = (name: string): boolean => new RegExp(`^${id}(?:-.*)?\\.md$`, "i").test(name);
  const dir = join(d.ROOT, "docs", "stories");
  const local = existsSync(dir) ? readdirSync(dir).find(named) : undefined;
  if (local) return { path: `docs/stories/${local}`, text: readFileSync(join(dir, local), "utf8") };
  if (!ref) return null;
  const name = lines(git("ls-tree", "--name-only", ref, "docs/stories/")).map((p) => basename(p)).find(named);
  if (!name) return null;
  const text = gitRaw(d.ROOT, ["show", `${ref}:docs/stories/${name}`]);
  return text === null ? null : { path: `docs/stories/${name}`, text };
}

/** The branch of a story: its file name without the extension, in lower case (`st-012-place-order`). */
export const storyBranch = (storyPath: string): string => basename(storyPath, ".md").toLowerCase();

function verifyFacts(branch: string | null, head: string | null, uncommitted: string[]): WorkerFacts["verify"] {
  const v = e.readVerifyState();
  if (!v) return { status: "not-run", at: null, commit: null, failed: [] };
  const failed = v.steps.filter((s) => !s.ok).map((s) => s.name);
  // Still valid when nothing but collected metrics changed since: the run was on this branch, on committed code,
  // and every later commit and uncommitted path is bookkeeping.
  const since = v.commit && head ? gitRaw(d.ROOT, ["diff", "--name-only", v.commit, head]) : null;
  const current =
    v.branch === branch &&
    !v.dirty &&
    since !== null &&
    lines(since).every(isMetricsPath) &&
    uncommitted.every(isMetricsPath);
  return { status: !current ? "stale" : v.ok ? "green" : "red", at: v.at ?? null, commit: v.commit ?? null, failed };
}

/** What keeps the story in the checkout from `done`. Empty while it is not `in-progress` there, or cannot be parsed. */
function doneBlockers(story: string, onBranch: boolean): string[] {
  if (!onBranch) return [];
  try {
    const stories = e.storiesById();
    const s = stories.get(story);
    return s && s.meta.status === "in-progress" ? e.transitionErrors(s, "in-progress", "done", stories) : [];
  } catch {
    return []; // an unreadable backlog is verify.ts's to report
  }
}

/** Everything about a worker pass that can be read instead of remembered. */
export function workerFacts(id: string, base: string): WorkerFacts {
  const story = id.toUpperCase();
  const baseCommit = git("rev-parse", "--verify", "--quiet", "--short", `${base}^{commit}`) || null;
  const located = locateStory(story, baseCommit ? base : null);
  const branch = located ? storyBranch(located.path) : null;
  const head = branch ? git("rev-parse", "--verify", "--quiet", "--short", `refs/heads/${branch}^{commit}`) || null : null;
  const current = git("rev-parse", "--abbrev-ref", "HEAD");
  const uncommitted = changedPaths(d.ROOT);
  const onBranch = !!branch && current === branch;

  const commits =
    head && baseCommit
      ? lines(git("log", "--reverse", "--format=%h%x09%s", `${base}..${branch}`)).map((l) => {
          const [sha, ...subject] = l.split("\t");
          return { sha, subject: subject.join("\t") };
        })
      : [];
  const changedFiles = head && baseCommit ? lines(git("diff", "--name-only", `${base}...${branch}`)) : [];

  const reviewsDir = join(d.ROOT, "docs", "reviews");
  const reviews = existsSync(reviewsDir)
    ? readdirSync(reviewsDir).filter((n) => n.toUpperCase().startsWith(`${story}-`) && n.endsWith(".md")).sort().map((n) => `docs/reviews/${n}`)
    : [];

  const onBase = located && baseCommit ? gitRaw(d.ROOT, ["show", `${base}:${located.path}`]) : null;
  const provider = loadBacklogConfig().provider;
  return {
    story,
    title: located ? frontValue(located.text, "title") : null,
    type: located ? frontValue(located.text, "type") : null,
    storyStatus: located ? frontValue(located.text, "status") : null,
    baseStatus: onBase === null ? null : frontValue(onBase, "status"),
    base,
    baseCommit,
    branch,
    branchExists: head !== null,
    current,
    head,
    commits,
    changedFiles,
    uncommitted,
    verify: onBranch ? verifyFacts(branch, head, uncommitted) : { status: "not-run", at: null, commit: null, failed: [] },
    reviews,
    unlinked: located && provider !== "local" && !hasExternalKey(located.text) ? provider : null,
    doneBlockers: doneBlockers(story, onBranch),
  };
}

// --------------------------------------------------------------------------
// Start of a pass
// --------------------------------------------------------------------------
export interface WorkerStart {
  /** `first` creates the story branch from the base; `continuation` goes on with the existing branch. */
  pass: "first" | "continuation";
  /** Why the pass cannot start. Not empty → nothing is switched and the worker reports `blocked`. */
  problems: string[];
  /** Git arguments that put the checkout on the story branch; empty when it is there already. */
  switch: string[];
}

/**
 * What a pass has to do before it starts, from the facts alone. A worker never pulls and never picks a story: the
 * story and the base are given. A branch that exists already makes the pass a continuation – after review findings,
 * after a decision the worker was blocked on, or after a pass that was cut off.
 */
export function planStart(f: WorkerFacts): WorkerStart {
  const pass: WorkerStart["pass"] = f.branchExists ? "continuation" : "first";
  const problems: string[] = [];
  if (!f.baseCommit) problems.push(`the base '${f.base}' does not exist in this checkout – a worker never fetches or pulls`);
  if (!f.branch) problems.push(`story ${f.story} was found neither in docs/stories/ nor on '${f.base}'`);
  const work = f.uncommitted.filter((p) => !isMetricsPath(p));
  if (work.length) {
    problems.push(`the working tree has uncommitted changes (${work.slice(0, 5).join(", ")}${work.length > 5 ? ", …" : ""}) – they are not this pass's to commit or discard`);
  }
  if (f.unlinked) problems.push(`the story has no external key for the ${f.unlinked} backlog – it is a stale mirror until it is linked`);
  if (f.branch && f.baseCommit && pass === "first" && f.baseStatus !== "ready") {
    problems.push(
      f.baseStatus === null
        ? `the story is not on '${f.base}' – a worker builds only what the base has approved`
        : `the story is '${f.baseStatus}' on '${f.base}', not 'ready' – only an approved story starts`,
    );
  }
  if (f.branch && pass === "continuation" && f.current === f.branch && f.storyStatus !== "ready" && f.storyStatus !== "in-progress") {
    problems.push(`the story is '${f.storyStatus ?? "?"}' on ${f.branch} – it has to be revised and approved before a worker continues`);
  }
  const target = f.branch ?? "";
  const sw = problems.length || f.current === target ? [] : pass === "first" ? ["switch", "-c", target, f.base] : ["switch", target];
  return { pass, problems, switch: sw };
}

// --------------------------------------------------------------------------
// The report
// --------------------------------------------------------------------------
export interface WorkerDetails {
  reason: string;
  /** Domain words the code needs that `CONTEXT.md` does not have – proposed, never written by the worker. */
  newTerms: { term: string; meaning: string }[];
  /** Decisions that deserve an ADR – proposed, never written by the worker. */
  adrProposals: { title: string; why: string }[];
  /** Decisions somebody else has to make. Any entry means the pass is not `ready-for-review`. */
  openQuestions: { question: string; kind: "domain" | "technical" }[];
  /**
   * Technical details the story left open that this pass settled with a default (the rule in the implement skill's
   * worker mode): they do not block, the orchestrator merges and lists them in the pull request for the user.
   */
  decisions: { question: string; decision: string; why: string }[];
  /** Review findings of a continuation pass and what became of them. */
  findings: { finding: string; action: "fixed" | "skipped" | "open" }[];
}

const DETAIL_KEYS = ["reason", "newTerms", "adrProposals", "openQuestions", "decisions", "findings"];
const QUESTION_KINDS = ["domain", "technical"];
const FINDING_ACTIONS = ["fixed", "skipped", "open"];

/** Parses the worker's part of the report. Unknown keys and incomplete items are errors, not silently dropped. */
export function parseDetails(raw: unknown): { details: WorkerDetails; errors: string[] } {
  const errors: string[] = [];
  const details: WorkerDetails = { reason: "", newTerms: [], adrProposals: [], openQuestions: [], decisions: [], findings: [] };
  if (raw === undefined || raw === null) return { details, errors };
  if (typeof raw !== "object" || Array.isArray(raw)) return { details, errors: ["the details must be a JSON object"] };
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) if (!DETAIL_KEYS.includes(key)) errors.push(`unknown key '${key}' (allowed: ${DETAIL_KEYS.join(", ")})`);
  if (obj.reason !== undefined) {
    if (typeof obj.reason === "string") details.reason = obj.reason.trim();
    else errors.push("reason must be a string");
  }
  const str = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
  const items = (key: keyof WorkerDetails, required: string[], check?: (item: Record<string, unknown>, where: string) => void): void => {
    const value = obj[key];
    if (value === undefined) return;
    if (!Array.isArray(value)) {
      errors.push(`${key} must be a list`);
      return;
    }
    value.forEach((item, i) => {
      const where = `${key}[${i}]`;
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        errors.push(`${where} must be an object with ${required.join(", ")}`);
        return;
      }
      const missing = required.filter((k) => !str((item as Record<string, unknown>)[k]));
      if (missing.length) errors.push(`${where} needs ${missing.join(", ")}`);
      check?.(item as Record<string, unknown>, where);
      (details[key] as unknown[]).push(item);
    });
  };
  items("newTerms", ["term", "meaning"]);
  items("adrProposals", ["title", "why"]);
  items("openQuestions", ["question", "kind"], (item, where) => {
    if (str(item.kind) && !QUESTION_KINDS.includes(item.kind)) errors.push(`${where}.kind must be ${QUESTION_KINDS.join(" or ")}`);
  });
  items("decisions", ["question", "decision", "why"]);
  items("findings", ["finding", "action"], (item, where) => {
    if (str(item.action) && !FINDING_ACTIONS.includes(item.action)) errors.push(`${where}.action must be ${FINDING_ACTIONS.join(", ")}`);
  });
  return { details, errors };
}

/**
 * Why the claimed result does not hold against the facts; empty means the report may be handed back. `blocked`
 * only needs its reason – it must always be possible to say that a pass is stuck.
 */
export function reportErrors(f: WorkerFacts, result: WorkerResult, details: WorkerDetails): string[] {
  const errs: string[] = [];
  if (result === "blocked") {
    if (!details.reason) errs.push("blocked needs a reason: what stops the pass and who can decide it");
    return errs;
  }
  if (!f.branch || f.current !== f.branch) errs.push(`the checkout is on '${f.current ?? "?"}', not on the story branch${f.branch ? ` '${f.branch}'` : ""}`);
  if (f.uncommitted.length) {
    errs.push(`uncommitted changes: ${f.uncommitted.slice(0, 5).join(", ")}${f.uncommitted.length > 5 ? ", …" : ""} – commit them (metrics as '${f.story}: metrics')`);
  }
  if (result === "returned-to-review") {
    if (f.storyStatus !== "review") errs.push(`the story is '${f.storyStatus ?? "?"}' – send it back first: story-status.ts ${f.story} review`);
    if (!details.reason) errs.push("returned-to-review needs a reason: what is wrong with the story");
    if (!details.openQuestions.length) errs.push("returned-to-review needs the open question(s) the story has to answer");
    return errs;
  }
  if (f.storyStatus !== "in-progress") errs.push(`the story is '${f.storyStatus ?? "?"}', not 'in-progress'`);
  if (!f.commits.length) errs.push(`the branch has no commit that is not on '${f.base}'`);
  if (f.verify.status !== "green") {
    const why = {
      "not-run": "verify.ts has not run on this branch",
      stale: "the code changed after the last verify.ts run (or the run was on uncommitted code) – commit, then run it again",
      red: `verify.ts is red (${f.verify.failed.join(", ")})`,
    }[f.verify.status];
    errs.push(`${why}. A pass without a green verify is 'blocked'`);
  }
  for (const b of f.doneBlockers) errs.push(`the story could not be set 'done' after the merge: ${b}`);
  if (details.openQuestions.length) errs.push("an open question is a decision nobody made yet – the result is 'blocked', not 'ready-for-review'");
  const open = details.findings.filter((x) => x.action === "open");
  if (open.length) errs.push(`${open.length} finding(s) are still open – the result is 'blocked', not 'ready-for-review'`);
  // A merge blocker is never a default and never skipped: fixed in the code with a test, or the pass is blocked.
  const skipped = details.findings.filter((x) => x.action === "skipped");
  for (const hit of blockerHits({ decisions: details.decisions, "skipped findings": skipped })) {
    errs.push(
      `${describeHit(hit)} – a merge blocker is never decided with a default or skipped: fix it in the code with a test ` +
        "(then it is no decision – drop the entry), or report 'blocked' with it as an open question",
    );
  }
  return errs;
}

/** The report as the orchestrator reads it: the worker's judgement first, then the facts. */
export function buildReport(f: WorkerFacts, result: WorkerResult, details: WorkerDetails): Record<string, unknown> {
  return {
    report: "implement-worker",
    version: 1,
    story: f.story,
    title: f.title,
    type: f.type,
    result,
    reason: details.reason,
    base: f.base,
    branch: f.branch,
    head: f.head,
    storyStatus: f.storyStatus,
    commits: f.commits,
    changedFiles: f.changedFiles,
    uncommitted: f.uncommitted,
    verify: f.verify,
    findings: details.findings,
    newTerms: details.newTerms,
    adrProposals: details.adrProposals,
    openQuestions: details.openQuestions,
    decisions: details.decisions,
  };
}
