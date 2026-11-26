/**
 * Shared, deterministic logic for the engineering workflow (`/implement`).
 *
 * Used by the scripts in .claude/skills/implement/scripts and by the hooks:
 *   - story selection and status transitions (ready → in-progress → done)
 *   - traceability between stories and code: test titles `ST-NNN: <scenario title>`,
 *     domain IDs (CMD-, EVT-, …) in the code, glossary language in code and message catalogs
 *   - the last result of `verify.ts`
 *
 * Builds on discovery.ts; same rules: Node >= 22.18, erasable TypeScript only.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import * as d from "./discovery.ts";
import * as research from "./research.ts";

const list = (v: unknown): string[] => (Array.isArray(v) ? v : []);

// --------------------------------------------------------------------------
// Git
// --------------------------------------------------------------------------
export function git(...args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd: d.ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

/** Content of a project-relative file at HEAD, or null if it is not committed yet. */
export function headContent(relPath: string): string | null {
  return git("show", `HEAD:${relPath}`);
}

// --------------------------------------------------------------------------
// Stories
// --------------------------------------------------------------------------
export function storiesById(): Map<string, d.Story> {
  return new Map(d.loadStories().parsed.map((s) => [d.storyId(s), s]));
}

export function findStory(id: string): d.Story {
  const s = storiesById().get(id.toUpperCase());
  if (!s) throw new Error(`story '${id}' not found in docs/stories/`);
  return s;
}

/** Scenario titles from the story's acceptance criteria, in order. */
export const scenarioTitles = (story: d.Story): string[] => d.scenarioTitlesIn(story.body);

/** Checklist items (`- [ ] …`) of a spike or tech task. */
export function checklist(story: d.Story): { done: boolean; text: string }[] {
  const ac = d.section(d.sections(story.body), "acceptance criteria") ?? "";
  const out: { done: boolean; text: string }[] = [];
  for (const line of ac.split("\n")) {
    const m = /^\s*[-*]\s*\[([ xX])\]\s*(.+?)\s*$/.exec(line);
    if (m) out.push({ done: m[1] !== " ", text: m[2] });
  }
  return out;
}

/** The test title every scenario must have, exactly: `ST-NNN: <scenario title>`. */
export const testTitle = (id: string, scenario: string): string => `${id}: ${scenario}`;

// --------------------------------------------------------------------------
// Status workflow
// --------------------------------------------------------------------------
/**
 * Allowed single steps. Discovery owns draft/review/ready-for-human-review; the linter sets the review state, the
 * user approves `ready`. Engineering moves ready → in-progress → done and sends a story back to review when it turns
 * out to be wrong. `done` is final: changes to finished behaviour become a new story.
 */
const TRANSITIONS: Record<string, string[]> = {
  draft: ["review", "superseded"],
  review: ["draft", "ready-for-human-review", "superseded"],
  // The linter gate passed; only the user turns this into `ready`.
  "ready-for-human-review": ["draft", "review", "ready", "superseded"],
  ready: ["review", "in-progress", "superseded"],
  "in-progress": ["review", "done"],
  done: [],
  // Final like done: the record of a story done elsewhere or replaced by a new planning (user, 2026-10-25).
  superseded: [],
};

function reachable(from: string, to: string): boolean {
  const seen = new Set([from]);
  const queue = [from];
  while (queue.length) {
    for (const next of TRANSITIONS[queue.shift()!] ?? []) {
      if (next === to) return true;
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return false;
}

/**
 * Errors for moving `story` from status `from` to `to` (possibly over several steps, e.g. between two commits).
 * Checks the path through the workflow and the preconditions of the target status.
 */
export function transitionErrors(story: d.Story, from: string, to: string, stories: Map<string, d.Story>): string[] {
  if (from === to) return [];
  const errs: string[] = [];
  if (!reachable(from, to)) {
    errs.push(
      from === "done" || from === "superseded"
        ? `a ${from} story is never reopened – capture the change as a new story`
        : `status '${from}' cannot become '${to}' (workflow: draft → review → ready-for-human-review → ready → in-progress → done, back to review when a story is wrong; superseded from any status before in-progress)`,
    );
    return errs;
  }
  if (to === "in-progress" || to === "done") {
    const open = list(story.meta.depends_on).filter((dep) => stories.get(dep)?.meta.status !== "done");
    if (open.length) errs.push(`depends on stories that are not done yet: ${open.join(", ")}`);
  }
  // The research gate is deterministic and applies at the status change, never retroactively: an existing `ready`
  // or `done` story is not re-opened because the gate learned about its risk after approval.
  if (to === "ready-for-human-review" || to === "ready") {
    errs.push(...research.researchGateErrors(story.meta));
  }
  // The linter gate and the user's approval are two separate steps; skipping one defeats the workflow.
  if (to === "ready" && from !== "ready-for-human-review") {
    errs.push("'ready' needs 'ready-for-human-review' first – run the spec linter and let the user approve");
  }
  if (to === "done") {
    if (d.isDomain(story.meta)) {
      const cov = scenarioCoverage(story);
      if (cov.missing.length) {
        errs.push(`scenarios without a test titled '${d.storyId(story)}: <scenario title>': ${cov.missing.map((m) => `"${m}"`).join(", ")}`);
      }
    }
    // Every checklist item must be ticked – for spikes and tech tasks, and for the foundation checklists a story
    // takes over just in time (e.g. "Foundation (moved from ST-074 …)").
    const open = checklist(story).filter((c) => !c.done);
    const short = (t: string) => (t.length > 60 ? `${t.slice(0, 57)}…` : t);
    if (open.length) errs.push(`${open.length} unticked acceptance criteria: ${open.map((c) => `"${short(c.text)}"`).join(", ")}`);
  }
  return errs;
}

/** Status of the story file at HEAD (null for a story that isn't committed yet). */
export function headStatus(story: d.Story): string | null {
  const text = headContent(d.rel(story.path));
  if (text === null) return null;
  const m = /^status:\s*(\S+)\s*$/m.exec(text.split("\n---")[0] ?? "");
  return m ? m[1] : null;
}

/** Rewrites the `status:` line in the story's frontmatter. */
export function writeStatus(story: d.Story, status: string): void {
  const text = readFileSync(story.path, "utf8");
  const end = text.indexOf("\n---", 4);
  const front = text.slice(0, end).replace(/^status:.*$/m, `status: ${status}`);
  writeFileSync(story.path, front + text.slice(end), "utf8");
}

/** Dependencies of a story that are not `done` yet. */
const openDeps = (s: d.Story, stories: Map<string, d.Story>): string[] =>
  list(s.meta.depends_on).filter((dep) => stories.get(dep)?.meta.status !== "done");

/** `ready` stories in backlog order. */
const readyInOrder = (stories: Map<string, d.Story>): d.Story[] =>
  d.backlogOrder([...stories.values()].filter((s) => s.meta.status === "ready"));

/** Next story to implement: the first `ready` one in backlog order whose dependencies are all done. */
export function nextStory(): { inProgress: d.Story[]; next: d.Story | null; blocked: d.Story[] } {
  const stories = storiesById();
  const inProgress = [...stories.values()].filter((s) => s.meta.status === "in-progress");
  const ready = readyInOrder(stories);
  return {
    inProgress,
    next: ready.find((s) => !openDeps(s, stories).length) ?? null,
    blocked: ready.filter((s) => openDeps(s, stories).length > 0),
  };
}

// --------------------------------------------------------------------------
// Marathon: run state and wave planning (`marathon-plan.ts`, `marathon-state.ts`)
// --------------------------------------------------------------------------
/**
 * The state of a marathon run. `in-progress` lives on the story branch only, so the integration branch cannot tell
 * which stories a run has taken – this file can. Plain JSON under .claude/state/, the same path for both
 * harnesses: it is resolved from this file's location (`d.ROOT`), never from the cwd or a harness variable.
 *
 * Read here, written only by `marathon-state.ts` (lib/marathon.ts): locked, atomic, validated.
 *
 * TODO(worktrees): in a git worktree `d.ROOT` is the worktree, not the main checkout – the state path has to be
 * resolved to the main worktree (`git rev-parse --git-common-dir`) before workers run in worktrees.
 */
export const MARATHON_STATE_FILE = join(d.ROOT, ".claude", "state", "marathon.json");

/** What a reviewer said about a story, as the orchestrator recorded it. */
export interface MarathonReview {
  agent: string;
  verdict: string;
  blocker: number;
  major: number;
  minor: number;
  question: number;
  /** Findings tagged `merge-blocker: <kind>` (`lib/merge-blockers.ts`); missing in states written before they were counted. */
  mergeBlocker?: number;
  /** Untagged findings of the review file that look like merge blockers – for the summary, never blocking. */
  possible?: PossibleMergeBlocker[];
  at: string;
}

export interface PossibleMergeBlocker {
  kind: string;
  text: string;
}

/** A decision somebody else has to make – the shape of a worker report's `openQuestions`. */
export interface MarathonQuestion {
  question: string;
  kind: string;
}

/**
 * A technical detail the story left open that the worker settled with a default instead of blocking – the shape of
 * a worker report's `decisions`. It is merged, and listed in the run's pull request for the user to confirm.
 */
export interface MarathonDecision {
  /** What was open. */
  question: string;
  /** The default that was built. */
  decision: string;
  /** Why it is safe: the convention or code it follows, why it is conservative and cheap to change. */
  why: string;
}

/**
 * Where a claimed story is: `worker` – a pass runs (or was cut off), `review` – reviews came back with something a
 * worker has to fix, `merge` – accepted, nothing left to fix. A resumed run reads it to decide how to go on.
 */
export const MARATHON_PHASES = ["worker", "review", "merge"] as const;
export type MarathonPhase = (typeof MARATHON_PHASES)[number];

export interface MarathonClaim {
  /** The story branch the worker builds on. */
  branch: string;
  /** ISO time the claim was taken. */
  start: string;
  /** Worker passes started for the story in this run, including the current one. */
  attempts: number;
  /** Of those, passes a resumed run started because the one before was cut off – not failures of the story. */
  resumed?: number;
  /** The story's `type` – the foundation gate needs it after the story left the backlog's `ready`. */
  type?: string;
  phase?: MarathonPhase;
  /** ISO time the current worker pass started; reviews recorded after it form the current round. */
  passStart?: string;
  reviews?: MarathonReview[];
}

/**
 * `merged`: the story branch is in the integration branch and the story is `done` there. `failed`: the pass gave up
 * without a result (no report, a red verify after the merge); the story may be retried once.
 */
export const MARATHON_OUTCOMES = ["merged", "failed"] as const;
export type MarathonOutcome = (typeof MARATHON_OUTCOMES)[number];

export interface MarathonResult {
  outcome: MarathonOutcome;
  /** ISO time the story left its claim. */
  at: string;
  branch?: string;
  /** Passes used so far – a retry continues counting from here. */
  attempts: number;
  /** Passes that only went on with one that was cut off (see `MarathonClaim.resumed`). */
  resumed?: number;
  type?: string;
  reason?: string;
  /** `failed` only: passes of the story that ended without a result, including this one. */
  failures?: number;
  reviews?: MarathonReview[];
  openQuestions?: MarathonQuestion[];
  decisions?: MarathonDecision[];
  notes?: string[];
}

export interface MarathonEscalation {
  story: string;
  reason: string;
  at: string;
  /** The story branch, when one exists – what was built stays there for the user. */
  branch?: string;
  attempts?: number;
  resumed?: number;
  type?: string;
  reviews?: MarathonReview[];
  openQuestions?: MarathonQuestion[];
  decisions?: MarathonDecision[];
  notes?: string[];
}

export interface MarathonLimits {
  /** Stories a run may start. */
  maxStories: number;
  /** Stories in a row that may end without a merge (escalated or failed) before the run stops. */
  maxFailures: number;
  /** Stop once the foundation tasks (`type: tech-task`) of the run are merged and a different story is next. */
  gateFoundation: boolean;
  /** Tokens the run's stories may use (input + output + cache read + cache write), or null. */
  budgetTokens: number | null;
  /** Cost the run's stories may reach, priced from `metrics.prices`, or null. */
  budgetUsd: number | null;
}

export interface MarathonState {
  version: 1;
  run: string;
  integrationBranch: string;
  /** The branch the integration branch was cut from and the pull request goes to. */
  base: string;
  status: "running" | "finished";
  startedAt: string;
  limits: MarathonLimits;
  /** Stories in a row that ended without a merge; a merge resets it. */
  consecutiveFailures: number;
  /** Story ID → open claim. A story leaves `claims` when it is merged, failed, escalated or released. */
  claims: Record<string, MarathonClaim>;
  /** Story ID → outcome of its last pass. */
  results: Record<string, MarathonResult>;
  /** Stories the run gave up on; they wait for the user and are never planned again in this run. */
  escalations: MarathonEscalation[];
  /** Why and when the run ended, and its pull request once it is open. Present when `status` is `finished`. */
  stop?: { reason: string; at: string; pr: string | null };
}

/** Problems with a parsed state file; empty means it is a valid `MarathonState`. */
export function marathonStateErrors(raw: unknown): string[] {
  const errs: string[] = [];
  const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  const str = (v: unknown): boolean => typeof v === "string" && v.length > 0;
  const count = (v: unknown): boolean => Number.isInteger(v) && (v as number) >= 0;
  const amount = (v: unknown): boolean => v === null || (typeof v === "number" && Number.isFinite(v) && v > 0);
  const reviews = (v: unknown): boolean =>
    v === undefined || (Array.isArray(v) && v.every((r) => obj(r) && str(r.agent) && str(r.verdict) && str(r.at) && ["blocker", "major", "minor", "question"].every((k) => count(r[k])) && (r.mergeBlocker === undefined || count(r.mergeBlocker)) && (r.possible === undefined || (Array.isArray(r.possible) && r.possible.every((p) => obj(p) && str(p.kind) && str(p.text))))));
  if (!obj(raw)) return ["the state is not a JSON object"];
  if (raw.version !== 1) errs.push(`version must be 1, is ${JSON.stringify(raw.version)}`);
  if (!str(raw.run)) errs.push("run (the run ID) is missing");
  if (!str(raw.integrationBranch)) errs.push("integrationBranch is missing");
  if (!str(raw.base)) errs.push("base (the branch the run was cut from) is missing");
  if (raw.status !== "running" && raw.status !== "finished") errs.push(`status must be running or finished, is ${JSON.stringify(raw.status)}`);
  if (!str(raw.startedAt)) errs.push("startedAt is missing");
  if (!count(raw.consecutiveFailures)) errs.push("consecutiveFailures must be a whole number ≥ 0");
  const l = raw.limits;
  if (!obj(l) || !count(l.maxStories) || !count(l.maxFailures) || typeof l.gateFoundation !== "boolean" || !amount(l.budgetTokens) || !amount(l.budgetUsd)) {
    errs.push("limits needs maxStories, maxFailures, gateFoundation, budgetTokens and budgetUsd (a number > 0 or null)");
  }
  if (!obj(raw.claims)) errs.push("claims must be an object (story ID → claim)");
  else {
    for (const [id, c] of Object.entries(raw.claims)) {
      if (!obj(c) || !str(c.branch) || !str(c.start) || !count(c.attempts)) errs.push(`claim ${id} needs branch, start and attempts`);
      else if (c.phase !== undefined && !(MARATHON_PHASES as readonly unknown[]).includes(c.phase)) errs.push(`claim ${id}: phase must be ${MARATHON_PHASES.join(", ")}`);
      else if (!reviews(c.reviews)) errs.push(`claim ${id}: every review needs agent, verdict, at and the four counts`);
    }
  }
  if (!obj(raw.results)) errs.push("results must be an object (story ID → result)");
  else {
    for (const [id, r] of Object.entries(raw.results)) {
      if (!obj(r) || !MARATHON_OUTCOMES.includes(r.outcome as MarathonOutcome) || !str(r.at) || !count(r.attempts)) {
        errs.push(`result ${id} needs outcome (${MARATHON_OUTCOMES.join(" | ")}), at and attempts`);
      }
    }
  }
  if (!Array.isArray(raw.escalations)) errs.push("escalations must be a list");
  else {
    raw.escalations.forEach((e, i) => {
      if (!obj(e) || !str(e.story) || typeof e.reason !== "string" || !str(e.at)) errs.push(`escalation #${i + 1} needs story, reason and at`);
    });
  }
  if (raw.status === "finished" && (!obj(raw.stop) || typeof raw.stop.reason !== "string" || !str(raw.stop.at))) {
    errs.push("a finished run needs stop (reason, at, pr)");
  }
  return errs;
}

/**
 * The claim state, or null when no run has started. A file that exists but is broken is an error, never an empty
 * state: planning from nothing would hand out stories another worker already holds.
 */
export function readMarathonState(path = MARATHON_STATE_FILE): MarathonState | null {
  if (!existsSync(path)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`${d.rel(path)} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  const errs = marathonStateErrors(raw);
  if (errs.length) throw new Error(`${d.rel(path)} is invalid:\n  - ${errs.join("\n  - ")}`);
  return raw as MarathonState;
}

export interface WavePlan {
  /** Up to `slots` stories to start now, in backlog order. */
  wave: { story: d.Story; attempts: number }[];
  /** Workers free for new stories: N minus the open claims. */
  slots: number;
  /** Ready stories that could start, before the slot limit. */
  eligible: number;
  claimed: string[];
  escalated: string[];
  /** Stories the run merged into the integration branch. */
  merged: string[];
  blocked: { story: d.Story; waitingFor: string[] }[];
  /** Why the wave is empty; null when it is not. */
  reason: string | null;
}

/**
 * The next wave of a marathon run: `ready` stories in backlog order whose `depends_on` are all `done`, that no
 * worker holds, that the run did not escalate and that it has not merged already. A `failed` story may run again;
 * its earlier attempts are carried over. `n` is the number of workers – the wave fills the slots that open claims
 * leave free.
 *
 * Pure: the stories and the state are passed in, nothing is read or written.
 */
export function planWave(stories: Map<string, d.Story>, state: MarathonState | null, n: number): WavePlan {
  if (!Number.isInteger(n) || n < 1) throw new Error(`N must be a whole number ≥ 1, is ${n}`);
  const claims = state?.claims ?? {};
  const results = state?.results ?? {};
  const claimed = new Set(Object.keys(claims));
  const escalated = new Set((state?.escalations ?? []).map((e) => e.story));
  const merged = new Set(Object.entries(results).filter(([, r]) => r.outcome === "merged").map(([id]) => id));

  const ready = readyInOrder(stories);
  const blocked: WavePlan["blocked"] = [];
  const candidates: d.Story[] = [];
  for (const s of ready) {
    const id = d.storyId(s);
    if (claimed.has(id) || escalated.has(id) || merged.has(id)) continue;
    const waitingFor = openDeps(s, stories);
    if (waitingFor.length) blocked.push({ story: s, waitingFor });
    else candidates.push(s);
  }

  const slots = Math.max(0, n - claimed.size);
  const wave: WavePlan["wave"] = [];
  for (const s of candidates) {
    if (wave.length >= slots) break;
    // TODO(conflict keys): for N > 1, skip a candidate whose conflict key (aggregate + context, optional `touches:`,
    // via lib/slices.ts) overlaps a story already in this wave or an open claim. Until then the CLI allows N = 1 only.
    wave.push({ story: s, attempts: results[d.storyId(s)]?.attempts ?? 0 });
  }

  let reason: string | null = null;
  if (!wave.length) {
    if (!stories.size) reason = "the backlog is empty";
    else if (!slots && candidates.length) reason = `no free worker – ${claimed.size} open claim(s) for N = ${n}`;
    else if (!ready.length) reason = "no story is ready";
    else if (blocked.length) reason = "every startable story waits for dependencies that are not done";
    else reason = "every ready story is claimed, merged or escalated";
  }
  return {
    wave,
    slots,
    eligible: candidates.length,
    claimed: [...claimed],
    escalated: [...escalated],
    merged: [...merged],
    blocked,
    reason,
  };
}

// --------------------------------------------------------------------------
// Code scanning
// --------------------------------------------------------------------------
/** Not application code: tooling, docs, generated output, dependencies. */
const IGNORED_DIRS = new Set([
  ".git", ".claude", ".opencode", ".kataster", "docs", "node_modules", ".next", ".next-e2e", ".vercel", ".turbo", "coverage", "dist", "build", "out",
  "playwright-report", "test-results", "public",
]);
const CODE_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]);
const TEST_RE = /(\.(test|spec)\.[cm]?[jt]sx?$)|(^|\/)(e2e|__tests__)\//;
// Test stand-ins of a module (engineering conventions): test code, but not tests – they carry no scenario titles.
const TEST_SUPPORT_RE = /\.test-support\.[cm]?[jt]sx?$/;
const CATALOG_DIR_RE = /(^|\/)(messages|locales|i18n)\//;

export function projectFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (!IGNORED_DIRS.has(e.name)) walk(join(dir, e.name));
      } else if (e.isFile()) {
        out.push(d.rel(join(dir, e.name)));
      }
    }
  };
  walk(d.ROOT);
  return out.sort();
}

export const isCode = (f: string): boolean => CODE_EXT.has(extname(f)) && !f.endsWith(".d.ts");
export const isTest = (f: string): boolean => isCode(f) && TEST_RE.test(f);
/** Tests plus test stand-ins – excluded from the domain ID and language checks of application code. */
export const isTestCode = (f: string): boolean => isTest(f) || (isCode(f) && TEST_SUPPORT_RE.test(f));
export const isCatalog = (f: string): boolean => extname(f) === ".json" && CATALOG_DIR_RE.test(f);
const read = (f: string): string => readFileSync(join(d.ROOT, f), "utf8");

/** Every `ST-NNN: …` title found in string literals of test files, with its location. */
export function testTitles(): { title: string; file: string }[] {
  const out: { title: string; file: string }[] = [];
  const re = /(["'`])(ST-\d{3}: (?:(?!\1)[^\n])+?)\1/g;
  for (const f of projectFiles().filter(isTest)) {
    for (const m of read(f).matchAll(re)) out.push({ title: m[2].replace(/\s+/g, " ").trim(), file: f });
  }
  return out;
}

export function scenarioCoverage(story: d.Story, titles = testTitles()): { covered: string[]; missing: string[] } {
  const id = d.storyId(story);
  const found = new Set(titles.map((t) => t.title));
  const covered: string[] = [];
  const missing: string[] = [];
  for (const sc of scenarioTitles(story)) (found.has(testTitle(id, sc).replace(/\s+/g, " ")) ? covered : missing).push(sc);
  return { covered, missing };
}

/**
 * Scenarios of finished stories that a later story replaced (ST-094): `docs/stories/superseded-scenarios.json` maps a
 * story ID to its scenario titles and the story that superseded each. A done story is never reopened, but its
 * scenario can stop being true – its test is then removed together with the superseding story's change, and the
 * scenario is listed here instead, with the reason in that story's pull request. `check-scenarios.ts` accepts no test
 * for a listed scenario and refuses a stale entry.
 */
export const SUPERSEDED_SCENARIOS_FILE = "docs/stories/superseded-scenarios.json";

export function supersededScenarios(): Map<string, Map<string, string>> {
  const file = join(d.ROOT, SUPERSEDED_SCENARIOS_FILE);
  if (!existsSync(file)) return new Map();
  const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, Record<string, string>>;
  return new Map(Object.entries(raw).map(([id, scenarios]) => [id, new Map(Object.entries(scenarios))]));
}

/** Domain IDs (`CMD-ReportProblem`, `EVT-DefectRecorded`, …) used in application code (not tests). */
export function domainIdsInCode(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const re = /\b(?:ACT|EXT|BC|AGG|EVT|CMD|POL|RM)-[A-Z][A-Za-z0-9]+\b/g;
  for (const f of projectFiles().filter((f) => isCode(f) && !isTestCode(f))) {
    for (const m of read(f).matchAll(re)) out.set(m[0], [...new Set([...(out.get(m[0]) ?? []), f])]);
  }
  return out;
}

// --------------------------------------------------------------------------
// Glossary language
// --------------------------------------------------------------------------
/**
 * Words from `_Avoid_` lists that are ordinary programming vocabulary. They are only flagged in
 * user-facing text (message catalogs), never in code identifiers.
 */
const GENERIC_CODE_WORDS = new Set([
  "id", "type", "class", "kind", "state", "error", "format", "tag", "upload", "log", "schedule", "unit",
  "device", "place", "position", "slot", "lock", "note", "comment", "review", "check", "title", "file type",
]);

export interface Glossary {
  terms: string[];
  avoid: { word: string; preferred: string }[];
}

export function loadGlossary(): Glossary {
  const path = join(d.ROOT, "CONTEXT.md");
  const terms: string[] = [];
  const avoid: { word: string; preferred: string }[] = [];
  if (!existsSync(path)) return { terms, avoid };
  let current = "";
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = /^\*\*(.+?)\*\*:?\s*$/.exec(line);
    if (t) {
      current = t[1].replace(/:$/, "").trim();
      terms.push(current.toLowerCase());
      continue;
    }
    const a = /^_Avoid_:\s*(.+)$/.exec(line);
    if (a && current) {
      for (const raw of a[1].replace(/\([^)]*\)/g, "").split(",")) {
        const word = raw.trim().toLowerCase();
        if (word) avoid.push({ word, preferred: current });
      }
    }
  }
  return { terms, avoid };
}

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Avoided words in a piece of text; glossary terms are masked first, so "Problem report" doesn't flag "problem". */
export function avoidedWords(text: string, g: Glossary, inCode: boolean): { word: string; preferred: string }[] {
  let masked = ` ${text.toLowerCase()} `;
  for (const term of [...g.terms].sort((a, b) => b.length - a.length)) {
    masked = masked.replace(new RegExp(`\\b${esc(term)}s?\\b`, "g"), " ¤ "); // plural too: problemReports
  }
  const hits = g.avoid.filter(({ word }) => {
    if (g.terms.includes(word)) return false; // avoided in one place, the proper term elsewhere
    if (inCode && GENERIC_CODE_WORDS.has(word)) return false;
    return new RegExp(`\\b${esc(word)}s?\\b`).test(masked);
  });
  return [...new Map(hits.map((h) => [h.word, h])).values()];
}

/** `fooBarBaz`, `foo_bar`, `FooBar` → "foo bar baz". */
export const identifierWords = (id: string): string =>
  id.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").replace(/[_\-$]+/g, " ").toLowerCase();

export interface LanguageFinding {
  file: string;
  where: string;
  word: string;
  preferred: string;
}

/** Language of docs and stories, from the project profile (default English). */
function artifactLanguage(): string {
  try {
    const profile = JSON.parse(readFileSync(join(d.ROOT, ".claude", "project.json"), "utf8"));
    return String(profile.languages?.artifacts ?? "en").toLowerCase();
  } catch {
    return "en";
  }
}

export function languageFindings(): LanguageFinding[] {
  const g = loadGlossary();
  if (!g.avoid.length) return [];
  // Names from the event storming ("Report problem", "Triage list") are domain language too
  const model = d.loadEventsModel() ?? {};
  for (const key of ["events", "commands", "policies", "read_models", "aggregates"]) {
    for (const item of (model[key] ?? []) as d.Obj[]) if (typeof item.name === "string") g.terms.push(item.name.toLowerCase());
  }
  const out: LanguageFinding[] = [];
  const files = projectFiles();
  // User-facing text in the artifact language: message catalog values (other catalogs use the _UI (<lang>)_ words)
  const language = artifactLanguage();
  for (const f of files.filter((f) => isCatalog(f) && basename(f).toLowerCase().startsWith(language))) {
    let data: unknown;
    try {
      data = JSON.parse(read(f));
    } catch {
      continue;
    }
    const walk = (v: unknown, key: string): void => {
      if (typeof v === "string") {
        for (const h of avoidedWords(v, g, false)) out.push({ file: f, where: key, ...h });
      } else if (v && typeof v === "object") {
        for (const [k, c] of Object.entries(v)) walk(c, key ? `${key}.${k}` : k);
      }
    };
    walk(data, "");
  }
  // Identifiers declared in application code
  const decl = /\b(?:const|let|var|function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g;
  for (const f of files.filter((f) => isCode(f) && !isTestCode(f))) {
    const lines = read(f).split("\n");
    lines.forEach((line, n) => {
      if (line.includes("language-ok")) return; // explicit exception, e.g. a third-party `user` object
      for (const m of line.matchAll(decl)) {
        for (const h of avoidedWords(identifierWords(m[1]), g, true)) out.push({ file: f, where: `line ${n + 1}: ${m[1]}`, ...h });
      }
    });
  }
  return out;
}

// --------------------------------------------------------------------------
// Verify state (read by the SessionStart hook)
// --------------------------------------------------------------------------
const STATE_FILE = join(d.ROOT, ".claude", "state", "last-verify.json");

export interface VerifyState {
  at: string;
  branch: string | null;
  commit: string | null;
  dirty: boolean;
  ok: boolean;
  steps: { name: string; ok: boolean; skipped?: boolean }[];
}

export function writeVerifyState(state: VerifyState): void {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n", "utf8");
}

export function readVerifyState(): VerifyState | null {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return null;
  }
}

// --------------------------------------------------------------------------
// Application tooling (root package.json – created by ST-001)
// --------------------------------------------------------------------------
export function appScripts(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(join(d.ROOT, "package.json"), "utf8")).scripts ?? {};
  } catch {
    return {};
  }
}

/** Path of a binary in the app's node_modules/.bin, or null if not installed. */
export function appBin(name: string): string | null {
  const p = join(d.ROOT, "node_modules", ".bin", name);
  return existsSync(p) ? p : null;
}
