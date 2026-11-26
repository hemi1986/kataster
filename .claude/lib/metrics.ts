/**
 * Story metrics – phase markers, token usage and time per story, for Claude Code and OpenCode alike.
 *
 * Three kinds of data, three places:
 *
 *   - **Markers** (`mark <target> <phase> start|end`) and **wait events** (permission prompts, questions) are local
 *     working data in `.claude/state/metrics/` of the main checkout – shared by every git worktree, never committed.
 *   - **Usage** is read where the harness keeps it: the Claude Code transcripts (JSONL) or the OpenCode database. A
 *     harness adapter (`metrics-claude.ts`, `metrics-opencode.ts`) turns it into the same `Stream` shape.
 *   - **Entries** – the result – are appended to `docs/stories/metrics/<target>.json` and committed with the story.
 *
 * A *stream* is one conversation: the main session or one subagent (Claude) / child session (OpenCode). A *pass* is
 * one start → end of a phase on one stream. Every assistant message belongs to at most one pass (the most recently
 * started one that is open at the message's time); a stream without markers of its own inherits the passes of its
 * parent, preferring `review-<agentType>` so parallel reviewers are kept apart. A message that matches no pass is
 * written to the `unassigned` pot when the session is finalised. Each message is counted once.
 *
 * Entries store raw tokens and the harness's own cost (`harnessCostUsd`) only. The price table and the split of
 * feature-level spec cost across stories are applied by the report, so both can change later.
 *
 * No imports from discovery.ts: the hooks load this file, and they must work before `npm install --prefix .claude`.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { ROOT } from "./config.ts";

// --------------------------------------------------------------------------
// Vocabulary
// --------------------------------------------------------------------------
export type Harness = "claude-code" | "opencode" | "unknown";
export const HARNESSES: readonly Harness[] = ["claude-code", "opencode", "unknown"];

/** The fixed phases; `review-<agent>` is open-ended (one per reviewer subagent). */
export const PHASES = [
  "shape",
  "grilling",
  "event-storming",
  "domain-architect",
  "story-writing",
  "review-stories",
  "kontext",
  "testplan",
  "characterization",
  "implementierung",
  "verify",
  "fixes",
  "merge",
] as const;
const REVIEW_PHASE_RE = /^review-[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** The pot for tokens outside every phase. Never a valid marker phase. */
export const UNASSIGNED = "unassigned";
/** Phases that may legitimately span sessions (a gate): finalising a session leaves them open. */
const CROSS_SESSION_PHASES = new Set(["merge"]);

export const isPhase = (phase: string): boolean => (PHASES as readonly string[]).includes(phase) || (REVIEW_PHASE_RE.test(phase) && phase !== "review-stories");

const STORY_TARGET_RE = /^ST-\d{3,}$/;
const FEATURE_TARGET_RE = /^feature:([a-z0-9]+(?:-[a-z0-9]+)*)$/;

/** `ST-012`, `st-012` → `ST-012`; `feature:order-photos` stays; anything else → null. */
export function normalizeTarget(raw: string): string | null {
  const t = raw.trim();
  if (/^st-\d{3,}$/i.test(t)) return t.toUpperCase();
  if (FEATURE_TARGET_RE.test(t)) return t;
  return null;
}
export const isStoryTarget = (t: string): boolean => STORY_TARGET_RE.test(t);
export const featureSlug = (t: string): string | null => FEATURE_TARGET_RE.exec(t)?.[1] ?? null;

/** The metrics file of a target: `ST-012.json`, `feature-order-photos.json`, `unassigned.json`. */
export function targetFile(root: string, target: string): string {
  const slug = featureSlug(target);
  const name = slug ? `feature-${slug}` : target === UNASSIGNED ? UNASSIGNED : target;
  return join(root, "docs", "stories", "metrics", `${name}.json`);
}

// --------------------------------------------------------------------------
// Tokens and usage
// --------------------------------------------------------------------------
/**
 * Normalised token counts – the same meaning for both harnesses, nothing counted twice:
 *
 *   input        uncached input tokens
 *   output       billed output tokens, *including* reasoning/thinking
 *   reasoning    the reasoning/thinking part of `output` (informational, already in `output`)
 *   cacheRead    tokens read from the prompt cache
 *   cacheWrite   tokens written to the prompt cache (all TTLs)
 *   cacheWrite1h the 1-hour-TTL part of `cacheWrite` (Claude only; already in `cacheWrite`)
 */
export interface Tokens {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h: number;
}
export const zeroTokens = (): Tokens => ({ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 });
export function addTokens(a: Tokens, b: Tokens): Tokens {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    reasoning: a.reasoning + b.reasoning,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    cacheWrite1h: a.cacheWrite1h + b.cacheWrite1h,
  };
}
/** Everything that went through the model: input + output + cache read + cache write. */
export const totalTokens = (t: Tokens): number => t.input + t.output + t.cacheRead + t.cacheWrite;

/** One deduplicated model response. `ts` is when it completed (ms since epoch). */
export interface UsageMessage {
  id: string;
  ts: number;
  model: string | null;
  provider: string | null;
  tokens: Tokens;
  /** The harness's own cost figure, when it records one (OpenCode). */
  harnessCostUsd: number | null;
}

export type Interval = [number, number];

/** One conversation: a main session or one subagent / child session. */
export interface Stream {
  /** `<harness>|<run>|<agent>` */
  key: string;
  harness: Harness;
  /** The root session id – one run of the harness. */
  run: string;
  /** The harness's own id of this conversation (Claude: the session id; OpenCode: this (child) session's id). */
  session: string;
  /** `main`, or the subagent id (Claude) / child session id (OpenCode). */
  agent: string;
  /** `main`, or the agent type (`code-reviewer`, `explore`, …). */
  agentType: string;
  /** Key of the parent stream; null for the main stream. */
  parent: string | null;
  messages: UsageMessage[];
  /** Time the stream waited for the user: open questions, permission prompts, the gap until the next prompt. */
  waits: Interval[];
  /** First and last activity of the stream (ms). */
  first: number;
  last: number;
  /** Sorted timestamps of every recorded entry – a permission prompt without a reply event ends at the next one. */
  activity: number[];
}

export const streamKey = (harness: Harness, run: string, agent: string): string => `${harness}|${run}|${agent}`;

// --------------------------------------------------------------------------
// Local state: markers and wait events
// --------------------------------------------------------------------------
export interface Marker {
  ts: string;
  target: string;
  phase: string;
  edge: "start" | "end";
  harness: Harness;
  /** Claude: the session id. OpenCode: the session the call came from (possibly a child session). */
  session: string;
  /** Claude: the subagent id, or `main`. OpenCode: always `main` – the adapter resolves child sessions. */
  agent: string;
  agentType: string;
  /** Claude: the main session's transcript path. */
  transcript?: string;
  /** The checkout the marker was set in (a worktree has its own `docs/stories/metrics/`). */
  root: string;
}

export type WaitKind = "permission.asked" | "permission.replied" | "question.asked" | "question.replied";
export interface WaitEvent {
  ts: string;
  harness: Harness;
  session: string;
  agent: string;
  kind: WaitKind;
  /** Pairs an `asked` with its `replied`: tool_use id, permission request id, form id. */
  id: string;
}

/**
 * The shared state directory: `.claude/state/metrics/` of the *main* checkout, so markers set in a git worktree and
 * wait events logged by the hooks (which always run in the main checkout) end up in one place.
 */
export function stateDir(): string {
  const override = process.env.KATASTER_METRICS_STATE;
  if (override) return override;
  const r = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: ROOT, encoding: "utf8", timeout: 5000 });
  const common = r.status === 0 ? r.stdout.trim() : "";
  const main = common && basename(common) === ".git" ? dirname(common) : ROOT;
  return join(main, ".claude", "state", "metrics");
}

const markersFile = (dir: string): string => join(dir, "markers.jsonl");
const eventsFile = (dir: string): string => join(dir, "events.jsonl");
const finalizedFile = (dir: string): string => join(dir, "finalized.json");

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const out: T[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // a torn line from a crash is skipped, not fatal
    }
  }
  return out;
}

/** One line per append (O_APPEND) – safe for concurrent writers of small records. */
function appendJsonl(path: string, record: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
}

export const readMarkers = (dir = stateDir()): Marker[] => readJsonl<Marker>(markersFile(dir));
export const appendMarker = (marker: Marker, dir = stateDir()): void => appendJsonl(markersFile(dir), marker);
export const readEvents = (dir = stateDir()): WaitEvent[] => readJsonl<WaitEvent>(eventsFile(dir));
export const appendEvent = (event: WaitEvent, dir = stateDir()): void => appendJsonl(eventsFile(dir), event);

/** Per run: everything up to this time (ms) has been finalised into the `unassigned` pot. */
export function readFinalized(dir = stateDir()): Record<string, number> {
  try {
    return JSON.parse(readFileSync(finalizedFile(dir), "utf8")) as Record<string, number>;
  } catch {
    return {};
  }
}
function writeFinalized(data: Record<string, number>, dir: string): void {
  mkdirSync(dir, { recursive: true });
  const tmp = `${finalizedFile(dir)}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  renameSync(tmp, finalizedFile(dir));
}

// --------------------------------------------------------------------------
// Locking (several workers append to the same files)
// --------------------------------------------------------------------------
const sleep = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

export function withLock<T>(path: string, fn: () => T): T {
  const lock = `${path}.lock`;
  mkdirSync(dirname(lock), { recursive: true });
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      // a lock older than 30 s belongs to a crashed writer
      try {
        if (Date.now() - statSync(lock).mtimeMs > 30_000) rmSync(lock, { recursive: true, force: true });
      } catch {
        // gone already
      }
      if (Date.now() > deadline) throw new Error(`could not lock ${path} – remove ${lock} if no other run is writing`);
      sleep(25);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

// --------------------------------------------------------------------------
// Entries – the committed result
// --------------------------------------------------------------------------
export interface Entry {
  /** Unique within the file; a second write of the same key is skipped (append-only, idempotent). */
  key: string;
  target: string;
  /** A phase, or `unassigned`. */
  phase: string;
  harness: Harness;
  run: string;
  session: string;
  agent: string;
  agentType: string;
  model: string | null;
  provider: string | null;
  /** ISO times of the pass (unassigned: the finalised range). */
  start: string;
  end: string;
  /** The pass was still open when its session was finalised; `end` is the last activity. */
  unclosed?: true;
  messages: number;
  tokens: Tokens;
  harnessCostUsd: number | null;
  /** Time spent working vs. waiting for the user. On the stream's primary-model row, 0 on its other rows. */
  agentMs: number;
  userWaitMs: number;
  recorded: string;
}

export interface MetricsFile {
  version: 1;
  target: string;
  entries: Entry[];
}

export function readMetricsFile(path: string): MetricsFile | null {
  if (!existsSync(path)) return null;
  const data = JSON.parse(readFileSync(path, "utf8")) as MetricsFile;
  if (!data || !Array.isArray(data.entries)) throw new Error(`${path}: not a metrics file (no entries array)`);
  return data;
}

/** One entry per line, so a diff shows appended entries as appended lines. */
function renderMetricsFile(file: MetricsFile): string {
  const lines = file.entries.map((e) => JSON.stringify(e));
  return `{"version":1,"target":${JSON.stringify(file.target)},"entries":[\n${lines.join(",\n")}\n]}\n`;
}

/** Appends entries whose key is not in the file yet. Returns the number written. */
export function appendEntries(root: string, target: string, entries: Entry[]): number {
  if (!entries.length) return 0;
  const path = targetFile(root, target);
  return withLock(path, () => {
    const file = readMetricsFile(path) ?? { version: 1 as const, target, entries: [] };
    const known = new Set(file.entries.map((e) => e.key));
    const fresh = entries.filter((e) => !known.has(e.key));
    if (!fresh.length) return 0;
    file.entries.push(...fresh);
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, renderMetricsFile(file), "utf8");
    renameSync(tmp, path);
    return fresh.length;
  });
}

export function metricsFiles(root = ROOT): string[] {
  const dir = join(root, "docs", "stories", "metrics");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => n.endsWith(".json"))
    .sort()
    .map((n) => join(dir, n));
}

// --------------------------------------------------------------------------
// Intervals
// --------------------------------------------------------------------------
export function mergeIntervals(list: Interval[]): Interval[] {
  const sorted = list.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const out: Interval[] = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}
export const measure = (list: Interval[]): number => mergeIntervals(list).reduce((n, [a, b]) => n + (b - a), 0);
export function clip(list: Interval[], [lo, hi]: Interval): Interval[] {
  return list.map(([a, b]): Interval => [Math.max(a, lo), Math.min(b, hi)]).filter(([a, b]) => b > a);
}
/** `base` minus every interval in `cut`. */
export function subtract(base: Interval[], cut: Interval[]): Interval[] {
  let out = mergeIntervals(base);
  for (const [c0, c1] of mergeIntervals(cut)) {
    const next: Interval[] = [];
    for (const [a, b] of out) {
      if (c1 <= a || c0 >= b) next.push([a, b]);
      else {
        if (c0 > a) next.push([a, c0]);
        if (c1 < b) next.push([c1, b]);
      }
    }
    out = next;
  }
  return out;
}

// --------------------------------------------------------------------------
// Adapters
// --------------------------------------------------------------------------
export interface Adapter {
  harness: Harness;
  /** The run and stream a marker or event belongs to. */
  locate(session: string, agent: string): { run: string; agent: string };
  /** Every stream of one run – the main conversation and all its children – with their waits. */
  load(run: string, hint: { transcript?: string }, events: WaitEvent[]): Stream[];
  /** Time (ms) of the run's last recorded activity; null when the run cannot be found. */
  lastActivity(run: string, hint: { transcript?: string }): number | null;
}

/**
 * Permission prompts and questions from the event log, as wait intervals of one stream. An `asked` without its
 * `replied` ends at the stream's next recorded activity (the harness writes nothing while it waits).
 */
export function eventWaits(events: WaitEvent[], matches: (e: WaitEvent) => boolean, activity: number[]): Interval[] {
  const replies = new Map<string, number>();
  for (const e of events) if (e.kind.endsWith(".replied")) replies.set(`${e.kind.split(".")[0]}|${e.id}`, Date.parse(e.ts));
  const out: Interval[] = [];
  for (const e of events) {
    if (!e.kind.endsWith(".asked") || !matches(e)) continue;
    const asked = Date.parse(e.ts);
    const replied = replies.get(`${e.kind.split(".")[0]}|${e.id}`) ?? activity.find((t) => t > asked);
    if (replied !== undefined && replied > asked) out.push([asked, replied]);
  }
  return out;
}

// --------------------------------------------------------------------------
// Passes and assignment
// --------------------------------------------------------------------------
export interface Pass {
  id: string;
  target: string;
  phase: string;
  start: number;
  /** null while the phase is open. */
  end: number | null;
  /** The stream that started it. */
  owner: string;
  /** Streams it covers: the owner, plus the stream that ended it when that is another session (a gate). */
  streams: Set<string>;
  /** The stream whose marker ended it. */
  endedBy: string | null;
  /** Checkout to write the entries to. */
  root: string;
}

export interface Located {
  marker: Marker;
  key: string;
  run: string;
}

/**
 * Builds the passes from the markers (sorted by time). An `end` closes the latest open pass of the same target and
 * phase on the same stream; failing that, one on another stream (a gate such as `merge` that spans sessions). A
 * second `start` of a pass that is already open is ignored, an `end` without a start is reported.
 */
export function buildPasses(located: Located[]): { passes: Pass[]; warnings: string[] } {
  const passes: Pass[] = [];
  const warnings: string[] = [];
  const sorted = [...located].sort((a, b) => Date.parse(a.marker.ts) - Date.parse(b.marker.ts));
  const open = (p: Pass) => p.end === null;
  for (const { marker: m, key } of sorted) {
    const ts = Date.parse(m.ts);
    const same = (p: Pass) => open(p) && p.target === m.target && p.phase === m.phase;
    if (m.edge === "start") {
      if (passes.some((p) => same(p) && p.owner === key)) continue;
      passes.push({ id: `${key}|${m.target}|${m.phase}|${m.ts}`, target: m.target, phase: m.phase, start: ts, end: null, owner: key, streams: new Set([key]), endedBy: null, root: m.root });
      continue;
    }
    const pick = (list: Pass[]) => list.sort((a, b) => b.start - a.start)[0];
    const own = pick(passes.filter((p) => same(p) && p.owner === key));
    const other = own ?? pick(passes.filter(same));
    if (!other) {
      warnings.push(`${m.ts}: '${m.target} ${m.phase} end' without a start – ignored`);
      continue;
    }
    other.end = ts;
    other.endedBy = key;
    other.streams.add(key);
  }
  return { passes, warnings };
}

/** The pass a message of `stream` at time `t` belongs to, or null. See the file header for the rule. */
export function assignPass(
  stream: Stream,
  t: number,
  passesOf: (key: string) => Pass[],
  streams: Map<string, Stream>,
): Pass | null {
  const active = (list: Pass[]) => list.filter((p) => p.start <= t && (p.end === null || t <= p.end));
  const latest = (list: Pass[]) => list.sort((a, b) => b.start - a.start)[0] ?? null;
  const own = passesOf(stream.key);
  if (own.length) return latest(active(own));
  for (let parent = stream.parent ? streams.get(stream.parent) : undefined; parent; parent = parent.parent ? streams.get(parent.parent) : undefined) {
    const inherited = passesOf(parent.key);
    if (!inherited.length) continue;
    const candidates = active(inherited);
    return candidates.find((p) => p.phase === `review-${stream.agentType}`) ?? latest(candidates);
  }
  return null;
}

/** The streams whose markers decide for `stream`: its own when it has any, else the nearest marked ancestor's. */
function deciding(stream: Stream, passesOf: (key: string) => Pass[], streams: Map<string, Stream>): Stream | null {
  for (let s: Stream | undefined = stream; s; s = s.parent ? streams.get(s.parent) : undefined) {
    if (passesOf(s.key).length) return s;
  }
  return null;
}

// --------------------------------------------------------------------------
// Entries from passes
// --------------------------------------------------------------------------
interface Bucket {
  stream: Stream;
  model: string | null;
  provider: string | null;
  tokens: Tokens;
  messages: number;
  harnessCostUsd: number | null;
}

function bucketize(rows: { stream: Stream; message: UsageMessage }[]): Bucket[] {
  const map = new Map<string, Bucket>();
  for (const { stream, message: m } of rows) {
    const k = `${stream.key}|${m.provider ?? ""}|${m.model ?? ""}`;
    const b = map.get(k) ?? { stream, model: m.model, provider: m.provider, tokens: zeroTokens(), messages: 0, harnessCostUsd: null };
    b.tokens = addTokens(b.tokens, m.tokens);
    b.messages += 1;
    if (m.harnessCostUsd !== null) b.harnessCostUsd = (b.harnessCostUsd ?? 0) + m.harnessCostUsd;
    map.set(k, b);
  }
  return [...map.values()];
}

/**
 * Working time of a stream inside a window: its activity span there, minus its waits. `marks` are the stream's own
 * marker times – a marker is activity too, even when the transcript's last line was written a moment earlier.
 */
function activeTime(stream: Stream, window: Interval, marks: number[] = []): { agentMs: number; waitMs: number } {
  const span = clip([[Math.min(stream.first, ...marks), Math.max(stream.last, ...marks)]], window);
  const waits = clip(stream.waits, window);
  const waitMs = measure(clip(waits, span[0] ?? [0, 0]));
  return { agentMs: Math.max(0, measure(span) - waitMs), waitMs };
}

const iso = (ms: number): string => new Date(ms).toISOString();

function entryOf(b: Bucket, target: string, phase: string, key: string, window: Interval, time: { agentMs: number; userWaitMs: number }, unclosed: boolean): Entry {
  const e: Entry = {
    key,
    target,
    phase,
    harness: b.stream.harness,
    run: b.stream.run,
    session: b.stream.session,
    agent: b.stream.agent,
    agentType: b.stream.agentType,
    model: b.model,
    provider: b.provider,
    start: iso(window[0]),
    end: iso(window[1]),
    messages: b.messages,
    tokens: b.tokens,
    harnessCostUsd: b.harnessCostUsd === null ? null : Math.round(b.harnessCostUsd * 1e6) / 1e6,
    agentMs: Math.round(time.agentMs),
    userWaitMs: Math.round(time.userWaitMs),
    recorded: new Date().toISOString(),
  };
  if (unclosed) e.unclosed = true;
  return e;
}

/** The bucket that carries the stream's time: the model with the most output; a token-less row when there is none. */
function primaryBuckets(buckets: Bucket[], timedStreams: Stream[]): Bucket[] {
  const out = [...buckets];
  for (const s of timedStreams) {
    if (!out.some((b) => b.stream.key === s.key)) out.push({ stream: s, model: null, provider: null, tokens: zeroTokens(), messages: 0, harnessCostUsd: null });
  }
  return out;
}

export interface Context {
  streams: Map<string, Stream>;
  passes: Pass[];
  passesOf: (key: string) => Pass[];
}

export function context(streams: Stream[], passes: Pass[]): Context {
  const byStream = new Map<string, Pass[]>();
  for (const p of passes) for (const k of p.streams) byStream.set(k, [...(byStream.get(k) ?? []), p]);
  return { streams: new Map(streams.map((s) => [s.key, s])), passes, passesOf: (k) => [...(byStream.get(k) ?? [])] };
}

/**
 * The entries of one pass: one per stream and model. `endOverride` closes a still-open pass at that time (a session
 * that ended with the phase open).
 */
export function passEntries(pass: Pass, ctx: Context, endOverride?: number): Entry[] {
  const end = pass.end ?? endOverride;
  if (end === undefined) return [];
  const window: Interval = [pass.start, end];
  const rows: { stream: Stream; message: UsageMessage }[] = [];
  for (const s of ctx.streams.values()) {
    for (const m of s.messages) if (assignPass(s, m.ts, ctx.passesOf, ctx.streams) === pass) rows.push({ stream: s, message: m });
  }
  const owners = [...pass.streams].map((k) => ctx.streams.get(k)).filter((s): s is Stream => s !== undefined);
  const buckets = primaryBuckets(bucketize(rows), owners);

  // Owner time: wall time of the pass minus the owners' waits. A gate that spans sessions counts the time no owner
  // was active as waiting – nobody worked on it in between.
  const wall = end - pass.start;
  const marksOf = (s: Stream): number[] => [...(s.key === pass.owner ? [pass.start] : []), ...(s.key === pass.endedBy && pass.end !== null ? [pass.end] : [])];
  const ownerAgent = owners.reduce((n, s) => n + activeTime(s, window, marksOf(s)).agentMs, 0);
  const ownerTime = owners.length ? { agentMs: ownerAgent, userWaitMs: Math.max(0, wall - ownerAgent) } : { agentMs: wall, userWaitMs: 0 };

  const timed = new Set<string>();
  const primary = (b: Bucket): boolean => {
    if (timed.has(b.stream.key)) return false;
    const best = buckets.filter((x) => x.stream.key === b.stream.key).sort((x, y) => y.tokens.output - x.tokens.output)[0];
    if (best !== b) return false;
    timed.add(b.stream.key);
    return true;
  };
  const ordered = [...buckets].sort((a, b) => b.tokens.output - a.tokens.output);
  return ordered.map((b) => {
    const isOwner = pass.streams.has(b.stream.key);
    let time = { agentMs: 0, userWaitMs: 0 };
    if (primary(b)) {
      if (isOwner) time = b.stream.key === pass.owner ? ownerTime : { agentMs: 0, userWaitMs: 0 };
      else {
        const t = activeTime(b.stream, window);
        time = { agentMs: t.agentMs, userWaitMs: t.waitMs };
      }
    }
    const key = `${pass.id}|${b.stream.key}|${b.provider ?? ""}/${b.model ?? ""}`;
    return entryOf(b, pass.target, pass.phase, key, window, time, pass.end === null);
  });
}

/**
 * The `unassigned` pot of one run since `since` (ms): messages that match no pass, and the time outside every pass.
 * A stream's pot goes to the target of its deciding stream's most recent marker before the message (or its first
 * marker); a run whose streams carry no markers at all goes to `unassigned.json`.
 */
export function unassignedEntries(
  runStreams: Stream[],
  ctx: Context,
  markers: Located[],
  since: number,
  until: number,
): { target: string; root: string; entries: Entry[] }[] {
  type Slot = { root: string; rows: { stream: Stream; message: UsageMessage }[]; time: Map<string, { agentMs: number; userWaitMs: number }> };
  const byTarget = new Map<string, Slot>();
  const slot = (target: string, root: string): Slot => {
    const s: Slot = byTarget.get(target) ?? { root, rows: [], time: new Map() };
    byTarget.set(target, s);
    return s;
  };
  const markersOf = (key: string) => markers.filter((m) => m.key === key).sort((a, b) => Date.parse(a.marker.ts) - Date.parse(b.marker.ts));
  const targetAt = (stream: Stream, t: number): { target: string; root: string } => {
    const d = deciding(stream, ctx.passesOf, ctx.streams);
    const list = d ? markersOf(d.key) : [];
    if (!list.length) return { target: UNASSIGNED, root: ROOT };
    const before = list.filter((m) => Date.parse(m.marker.ts) <= t);
    const m = (before[before.length - 1] ?? list[0]).marker;
    return { target: m.target, root: m.root };
  };

  for (const s of runStreams) {
    for (const m of s.messages) {
      if (m.ts <= since || m.ts > until) continue;
      if (assignPass(s, m.ts, ctx.passesOf, ctx.streams)) continue;
      const { target, root } = targetAt(s, m.ts);
      slot(target, root).rows.push({ stream: s, message: m });
    }
    // Time outside every pass that covers this stream, split at the markers that change the target.
    const d = deciding(s, ctx.passesOf, ctx.streams);
    const covering = d ? ctx.passesOf(d.key).map((p): Interval => [p.start, p.end ?? Number.POSITIVE_INFINITY]) : [];
    const lo = Math.max(since, s.first);
    const hi = Math.min(until, s.last);
    if (hi <= lo) continue;
    const free = subtract([[lo, hi]], covering);
    const cuts = d ? markersOf(d.key).map((m) => Date.parse(m.marker.ts)) : [];
    for (const [a, b] of free) {
      const points = [a, ...cuts.filter((c) => c > a && c < b), b];
      for (let i = 0; i + 1 < points.length; i++) {
        const seg: Interval = [points[i], points[i + 1]];
        const { target, root } = targetAt(s, seg[0]);
        const t = activeTime(s, seg);
        const sl = slot(target, root);
        const prev = sl.time.get(s.key) ?? { agentMs: 0, userWaitMs: 0 };
        sl.time.set(s.key, { agentMs: prev.agentMs + t.agentMs, userWaitMs: prev.userWaitMs + t.waitMs });
      }
    }
  }

  const window: Interval = [since, until];
  const out: { target: string; root: string; entries: Entry[] }[] = [];
  for (const [target, sl] of byTarget) {
    const timedStreams = runStreams.filter((s) => {
      const t = sl.time.get(s.key);
      return t !== undefined && t.agentMs + t.userWaitMs > 0;
    });
    const buckets = primaryBuckets(bucketize(sl.rows), timedStreams);
    const seen = new Set<string>();
    const entries = [...buckets]
      .sort((a, b) => b.tokens.output - a.tokens.output)
      .map((b) => {
        const first = !seen.has(b.stream.key);
        seen.add(b.stream.key);
        const t = first ? sl.time.get(b.stream.key) ?? { agentMs: 0, userWaitMs: 0 } : { agentMs: 0, userWaitMs: 0 };
        const key = `${UNASSIGNED}|${b.stream.key}|${b.provider ?? ""}/${b.model ?? ""}|${target}|${iso(since)}`;
        return entryOf(b, target, UNASSIGNED, key, window, t, false);
      })
      .filter((e) => e.messages > 0 || e.agentMs + e.userWaitMs > 0);
    if (entries.length) out.push({ target, root: sl.root, entries });
  }
  return out;
}

// --------------------------------------------------------------------------
// Collection: what `mark … end`, `collect` and the session hooks run
// --------------------------------------------------------------------------
export interface Collector {
  adapters: Partial<Record<Harness, Adapter>>;
  dir: string;
}

export interface CollectResult {
  written: { target: string; phase: string; entries: number }[];
  warnings: string[];
}

function locateAll(markers: Marker[], col: Collector, warnings: string[]): Located[] {
  const out: Located[] = [];
  for (const m of markers) {
    const adapter = col.adapters[m.harness];
    let run = m.session;
    let agent = m.agent || "main";
    if (adapter) {
      try {
        ({ run, agent } = adapter.locate(m.session, agent));
      } catch (e) {
        warnings.push(`${m.harness} ${m.session}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    out.push({ marker: m, key: streamKey(m.harness, run, agent), run });
  }
  return out;
}

/** Streams of the given runs. A run whose harness is unknown or unreadable gets a token-less stand-in. */
function loadRuns(runs: Map<string, { harness: Harness; transcript?: string }>, col: Collector, located: Located[], warnings: string[]): Stream[] {
  const events = readEvents(col.dir);
  const out: Stream[] = [];
  for (const [run, { harness, transcript }] of runs) {
    const adapter = col.adapters[harness];
    let streams: Stream[] = [];
    if (adapter) {
      try {
        streams = adapter.load(run, { transcript }, events);
      } catch (e) {
        warnings.push(`${harness} ${run}: ${e instanceof Error ? e.message : String(e)} – time only, no tokens`);
      }
    }
    // Marked streams the harness did not return (no hook, unreadable transcript): time from the markers alone.
    for (const l of located.filter((x) => x.run === run)) {
      if (streams.some((s) => s.key === l.key) || out.some((s) => s.key === l.key)) continue;
      const ts = located.filter((x) => x.key === l.key).map((x) => Date.parse(x.marker.ts));
      streams.push({
        key: l.key, harness, run, session: l.marker.session, agent: l.marker.agent || "main", agentType: l.marker.agentType || "main",
        parent: null, messages: [], waits: [], first: Math.min(...ts), last: Math.max(...ts), activity: ts.sort((a, b) => a - b),
      });
    }
    out.push(...streams);
  }
  return out;
}

function runsOf(located: Located[], keys: Set<string>): Map<string, { harness: Harness; transcript?: string }> {
  const runs = new Map<string, { harness: Harness; transcript?: string }>();
  for (const l of located) {
    if (!keys.has(l.key)) continue;
    const prev = runs.get(l.run);
    runs.set(l.run, { harness: l.marker.harness, transcript: prev?.transcript ?? l.marker.transcript });
  }
  return runs;
}

function write(result: CollectResult, root: string, target: string, phase: string, entries: Entry[]): void {
  const n = appendEntries(root, target, entries);
  if (n) result.written.push({ target, phase, entries: n });
}

/** Writes the entries of the pass the given `end` marker just closed (and nothing else). */
export function collectPass(endMarker: Marker, col: Collector): CollectResult {
  const result: CollectResult = { written: [], warnings: [] };
  const located = locateAll(readMarkers(col.dir), col, result.warnings);
  const { passes, warnings } = buildPasses(located);
  result.warnings.push(...warnings);
  const endTs = Date.parse(endMarker.ts);
  const pass = passes.find((p) => p.end === endTs && p.target === endMarker.target && p.phase === endMarker.phase);
  if (!pass) return result;
  const streams = loadRuns(runsOf(located, pass.streams), col, located, result.warnings);
  const ctx = context(streams, passes);
  write(result, pass.root, pass.target, pass.phase, passEntries(pass, ctx));
  return result;
}

/**
 * Finalises runs: writes every pass entry not written yet (self-healing after a failed `end`), closes passes the
 * session left open (except gates like `merge`), and moves everything outside a pass into the `unassigned` pot.
 * Runs are picked by id, or – `stale` – every run with markers whose last activity is older than `idleMs`.
 */
export function collectRuns(col: Collector, opts: { runs?: string[]; stale?: boolean; idleMs?: number; exclude?: string[] }): CollectResult {
  const result: CollectResult = { written: [], warnings: [] };
  const located = locateAll(readMarkers(col.dir), col, result.warnings);
  const { passes, warnings } = buildPasses(located);
  result.warnings.push(...warnings);
  const finalized = readFinalized(col.dir);
  const allRuns = runsOf(located, new Set(located.map((l) => l.key)));
  const exclude = new Set(opts.exclude ?? []);
  const idle = opts.idleMs ?? 30 * 60_000;

  const chosen = new Map<string, { harness: Harness; transcript?: string }>();
  for (const [run, info] of allRuns) {
    if (exclude.has(run)) continue;
    if (opts.runs && !opts.runs.includes(run)) continue;
    if (opts.stale) {
      const last = col.adapters[info.harness]?.lastActivity(run, info) ?? null;
      if (last === null || Date.now() - last < idle) continue;
      if ((finalized[run] ?? 0) >= last) continue;
    }
    chosen.set(run, info);
  }

  for (const [run, info] of chosen) {
    // Passes that cover this run, plus every run they touch (a gate ended in another session).
    const runKeys = new Set(located.filter((l) => l.run === run).map((l) => l.key));
    const touching = passes.filter((p) => [...p.streams].some((k) => runKeys.has(k)));
    const keys = new Set<string>(runKeys);
    for (const p of touching) for (const k of p.streams) keys.add(k);
    const streams = loadRuns(runsOf(located, keys), col, located, result.warnings);
    if (!streams.some((s) => s.run === run)) {
      result.warnings.push(`${info.harness} ${run}: no usage found`);
      continue;
    }
    const ctx = context(streams, passes);
    const runStreams = streams.filter((s) => s.run === run);
    const until = Math.max(...runStreams.map((s) => s.last));

    for (const p of touching) {
      const ownerRun = ctx.streams.get(p.owner)?.run;
      if (p.end !== null) write(result, p.root, p.target, p.phase, passEntries(p, ctx));
      else if (ownerRun === run && !CROSS_SESSION_PHASES.has(p.phase)) {
        const owner = ctx.streams.get(p.owner);
        if (owner) write(result, p.root, p.target, p.phase, passEntries(p, ctx, Math.max(p.start, owner.last)));
      }
    }
    const since = finalized[run] ?? 0;
    for (const pot of unassignedEntries(runStreams, ctx, located.filter((l) => l.run === run), since, until)) {
      write(result, pot.root, pot.target, UNASSIGNED, pot.entries);
    }
    withLock(finalizedFile(col.dir), () => {
      const current = readFinalized(col.dir);
      current[run] = Math.max(current[run] ?? 0, until);
      writeFinalized(current, col.dir);
    });
  }
  return result;
}

// --------------------------------------------------------------------------
// Prices (used by the report only – never stored)
// --------------------------------------------------------------------------
/** USD per million tokens. `cacheWrite1h` falls back to `cacheWrite`. */
export interface Price {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  cacheWrite1h?: number;
}
export type PriceTable = Record<string, Price>;

export function loadPrices(root = ROOT): { prices: PriceTable; errors: string[] } {
  const errors: string[] = [];
  let raw: unknown;
  try {
    raw = (JSON.parse(readFileSync(join(root, ".claude", "project.json"), "utf8")) as { metrics?: { prices?: unknown } }).metrics?.prices;
  } catch {
    return { prices: {}, errors };
  }
  if (raw === undefined || raw === null) return { prices: {}, errors };
  if (typeof raw !== "object" || Array.isArray(raw)) return { prices: {}, errors: ["metrics.prices must be an object: { \"<model>\": { \"input\": …, \"output\": … } }"] };
  const prices: PriceTable = {};
  for (const [model, p] of Object.entries(raw as Record<string, unknown>)) {
    const price = p as Record<string, unknown>;
    const fields = ["input", "output", "cacheRead", "cacheWrite", "cacheWrite1h"];
    const bad = fields.filter((f) => price?.[f] !== undefined && (typeof price[f] !== "number" || (price[f] as number) < 0));
    const unknown = Object.keys(price ?? {}).filter((f) => !fields.includes(f));
    if (typeof price?.input !== "number" || typeof price?.output !== "number") bad.push("input/output (required)");
    if (bad.length || unknown.length) {
      errors.push(`metrics.prices["${model}"]: ${[...bad.map((f) => `${f} must be a number ≥ 0`), ...unknown.map((f) => `unknown field '${f}'`)].join(", ")}`);
      continue;
    }
    prices[model] = price as unknown as Price;
  }
  return { prices, errors };
}

/** The price of a model: `<provider>/<model>` first, then `<model>`. */
export function priceFor(prices: PriceTable, model: string | null, provider: string | null): Price | null {
  if (!model) return null;
  return (provider ? prices[`${provider}/${model}`] : undefined) ?? prices[model] ?? null;
}

/**
 * Cost of normalised tokens in USD; null when the model has no price, or a token class it used has none.
 * Reasoning is part of `output`, the 1-hour cache write part of `cacheWrite` – neither is charged twice.
 */
export function costOf(tokens: Tokens, price: Price | null): number | null {
  if (totalTokens(tokens) === 0) return 0;
  if (!price) return null;
  const write5m = tokens.cacheWrite - tokens.cacheWrite1h;
  const parts: [number, number | undefined][] = [
    [tokens.input, price.input],
    [tokens.output, price.output],
    [tokens.cacheRead, price.cacheRead],
    [write5m, price.cacheWrite],
    [tokens.cacheWrite1h, price.cacheWrite1h ?? price.cacheWrite],
  ];
  let usd = 0;
  for (const [n, p] of parts) {
    if (n === 0) continue;
    if (p === undefined) return null;
    usd += (n * p) / 1_000_000;
  }
  return usd;
}
