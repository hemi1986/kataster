/**
 * Who may act in a marathon run – the lease. One orchestrator and one worker hold it at a time; whoever is replaced
 * is **superseded**, and a superseded session cannot write any more: `hooks/marathon-guard.ts` blocks its tool calls
 * in both harnesses while the run is running.
 *
 * Why: a session can outlive the terminal that started it. OpenCode runs sessions in its background service, so a
 * closed TUI leaves its orchestrator and its worker running; a resumed run would start a second worker on the same
 * checkout. A heuristic (watch `git status` for a minute) cannot see a worker that is thinking or only commits
 * metrics, so the guard does not guess: the newest holder wins, the one before it is blocked.
 *
 *   start-run, resume  the calling session becomes the orchestrator; the one before is superseded. `resume` also
 *                      supersedes the worker of every claim it continues – an orphaned pass is dead by definition,
 *                      and if it is not, it is stopped here.
 *   worker.ts start    the calling session becomes the worker of the claimed story; an earlier worker is superseded.
 *   writes             marathon-state.ts refuses a write from a session that is not the orchestrator.
 *
 * The caller is `<harness>:<id>` – the subagent's `agent_id` in Claude Code, the (child) session in OpenCode.
 * Hooks append it to `worker.ts start|report` and `marathon-state.ts` calls as `--caller` (`hooks/metrics.ts`); a
 * call without it (a person in a terminal) is not checked.
 *
 * This module is read by a hook on every tool call: node built-ins only, no YAML, no git.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// KATASTER_STATE_DIR moves the state – for tests only.
const STATE_DIR = process.env.KATASTER_STATE_DIR || join(import.meta.dirname, "..", "state");
export const LEASE_FILE = join(STATE_DIR, "marathon-lease.json");
const RUN_FILE = join(STATE_DIR, "marathon.json");
/** The last report of every claimed story's worker – what a resumed run reads instead of starting another pass. */
export const REPORTS_DIR = join(STATE_DIR, "marathon-reports");
export const STATE_FILE = RUN_FILE;
export const reportFile = (story: string, dir = REPORTS_DIR): string => join(dir, `${story.toUpperCase()}.json`);

export type Role = "orchestrator" | "worker";

export interface Holder {
  caller: string;
  since: string;
}
export interface WorkerHolder extends Holder {
  story: string;
  pass: number;
}
export interface Superseded {
  caller: string;
  role: Role;
  story?: string;
  pass?: number;
  /** When it was replaced, and by whom. */
  at: string;
  by: string;
}
export interface Lease {
  version: 1;
  run: string;
  orchestrator: Holder | null;
  worker: WorkerHolder | null;
  superseded: Superseded[];
}

/** The caller of a hook payload: `claude-code:<agent_id or session_id>`, `opencode:<session_id>`; null when unknown. */
export function callerOf(payload: Record<string, unknown>): string | null {
  const harness = payload.harness === "opencode" ? "opencode" : "claude-code";
  const agent = typeof payload.agent_id === "string" ? payload.agent_id : "";
  const session = typeof payload.session_id === "string" ? payload.session_id : "";
  const id = agent || session;
  return id ? `${harness}:${id}` : null;
}

export const emptyLease = (run: string): Lease => ({ version: 1, run, orchestrator: null, worker: null, superseded: [] });

/** The lease of `run` – a lease left from another run counts as none. */
export const leaseOf = (lease: Lease | null, run: string): Lease => (lease && lease.run === run ? structuredClone(lease) : emptyLease(run));

export const isSuperseded = (lease: Lease | null, caller: string | null): Superseded | null =>
  (caller && lease?.superseded.find((s) => s.caller === caller)) || null;

function supersede(lease: Lease, entry: Omit<Superseded, "at" | "by">, by: string, now: string): void {
  if (entry.caller === by) return;
  lease.superseded = [...lease.superseded.filter((s) => s.caller !== entry.caller), { ...entry, at: now, by }];
}

/** `caller` becomes the orchestrator of `run`; the orchestrator before it is superseded. */
export function takeOrchestrator(lease: Lease | null, run: string, caller: string, now: string): Lease {
  const next = leaseOf(lease, run);
  const old = next.orchestrator;
  if (old && old.caller !== caller) supersede(next, { caller: old.caller, role: "orchestrator" }, caller, now);
  next.superseded = next.superseded.filter((s) => s.caller !== caller);
  if (!old || old.caller !== caller) next.orchestrator = { caller, since: now };
  return next;
}

/** The worker of `story` is given up – a resumed run continues that pass with a fresh worker. */
export function supersedeWorker(lease: Lease | null, run: string, story: string, by: string, now: string): Lease {
  const next = leaseOf(lease, run);
  const w = next.worker;
  if (w && w.story === story) {
    supersede(next, { caller: w.caller, role: "worker", story: w.story, pass: w.pass }, by, now);
    next.worker = null;
  }
  return next;
}

/** `caller` becomes the worker of `story` (pass `pass`); a different worker before it is superseded. */
export function takeWorker(lease: Lease | null, run: string, story: string, pass: number, caller: string, now: string): { lease: Lease; replaced: WorkerHolder | null } {
  const next = leaseOf(lease, run);
  const old = next.worker;
  const replaced = old && old.caller !== caller ? old : null;
  if (replaced) supersede(next, { caller: replaced.caller, role: "worker", story: replaced.story, pass: replaced.pass }, caller, now);
  next.superseded = next.superseded.filter((s) => s.caller !== caller);
  next.worker = { story, pass, caller, since: old && !replaced ? old.since : now };
  return { lease: next, replaced };
}

const stopNow = "Stop now: end your turn without further tool calls and without a report.";

/** Why `caller` may not write as the orchestrator of `run`; null when it may. A missing caller is not checked. */
export function orchestratorError(lease: Lease | null, run: string, caller: string | null): string | null {
  if (!caller) return null;
  const l = lease && lease.run === run ? lease : null;
  const gone = isSuperseded(l, caller);
  if (gone) return `this session was replaced as the ${gone.role} of run ${run} at ${gone.at} (by ${gone.by}). ${stopNow}`;
  if (l?.orchestrator && l.orchestrator.caller !== caller) {
    return `${l.orchestrator.caller} is the orchestrator of run ${run} since ${l.orchestrator.since} – only one session runs a marathon. Take the run over with \`marathon-state.ts resume\`, after that session is closed.`;
  }
  return null;
}

/** Why `caller` may not hand in the report of `story`; null when it may. */
export function workerError(lease: Lease | null, run: string, story: string, caller: string | null): string | null {
  if (!caller) return null;
  const l = lease && lease.run === run ? lease : null;
  const gone = isSuperseded(l, caller);
  if (gone) return `this worker was replaced at ${gone.at} (by ${gone.by}) – another worker builds ${story} now. ${stopNow}`;
  if (l?.worker && l.worker.story === story && l.worker.caller !== caller) {
    return `${l.worker.caller} is the worker of ${story} (pass ${l.worker.pass}) – this session is not. ${stopNow}`;
  }
  return null;
}

/** The lease on disk; null when there is none or it cannot be read (a broken lease blocks nobody). */
export function readLease(path = LEASE_FILE): Lease | null {
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    return raw && raw.version === 1 && typeof raw.run === "string" && Array.isArray(raw.superseded) ? (raw as Lease) : null;
  } catch {
    return null;
  }
}

/** The ID of the run that is running, read without validation (a hook must stay cheap); null otherwise. */
export function runningRun(path = RUN_FILE): string | null {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    return raw?.status === "running" && typeof raw.run === "string" ? raw.run : null;
  } catch {
    return null;
  }
}

/**
 * Tool calls that schedule work for later – it would run outside the run's control, after the session that made it:
 * Claude Code's cron, remote triggers and wakeups, OpenCode's automations (a tool of their own, or created from a
 * Code Mode script).
 */
export function isScheduling(toolName: string, toolInput: unknown): boolean {
  if (["CronCreate", "RemoteTrigger", "ScheduleWakeup"].includes(toolName)) return true;
  if (/^automation/i.test(toolName) && !/\.(list|get)$/i.test(toolName)) return true;
  if (toolName === "execute") {
    const text = typeof toolInput === "string" ? toolInput : JSON.stringify(toolInput ?? "");
    return /\bautomation\s*\.\s*(create|resume|update)\b/.test(text);
  }
  return false;
}

/** A worker's last report, as `worker.ts report` keeps it for a resumed run. */
export interface KeptReport {
  run: string;
  story: string;
  pass: number;
  caller: string | null;
  at: string;
  /** Head of the story branch when the report was made – a later commit makes the report stale. */
  head: string | null;
  result: string;
  report: Record<string, unknown>;
}

export function readReport(story: string, dir = REPORTS_DIR): KeptReport | null {
  const file = reportFile(story, dir);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as KeptReport;
  } catch {
    return null;
  }
}
