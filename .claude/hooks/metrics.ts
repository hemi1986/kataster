/**
 * Metrics hook – shared by Claude Code (settings.json) and OpenCode (the plugin sends the same JSON).
 *
 *   PreToolUse (Bash)   a `story-metrics.ts mark …` call gets the caller's identity appended right after `mark`:
 *                       --harness, --session, --agent/--agent-type (subagents), --transcript. A `worker.ts start|report`
 *                       or `marathon-state.ts <command>` call gets `--caller <harness>:<id>` – the marathon lease
 *                       (lib/lease.ts) decides with it who may write. The command is rewritten through `updatedInput`;
 *                       the permission decision stays with the harness.
 *   PermissionRequest   logs `permission.asked` – the wait ends at the stream's next transcript line.
 *   KatasterEvent       (OpenCode plugin) permission.asked/replied and form.created/replied/cancelled → wait events.
 *   SessionEnd          finalises this session's metrics (entries not written yet, open phases, the unassigned pot).
 *   SessionStart        finalises earlier sessions that ended without SessionEnd (crash, closed terminal).
 *
 * Never blocks and never fails the tool call: every error is swallowed (set KATASTER_METRICS_DEBUG=1 to see it).
 * The PreToolUse path imports only the quote-aware command splitter, so it stays fast and works before
 * `npm install --prefix .claude`.
 */
import { readFileSync } from "node:fs";
import { callerOf } from "../lib/lease.ts";
import { segments } from "../lib/shell.ts";

let data: Record<string, any>;
try {
  data = JSON.parse(readFileSync(0, "utf8"));
} catch {
  process.exit(0);
}

const debug = (e: unknown): void => {
  if (process.env.KATASTER_METRICS_DEBUG) process.stderr.write(`[metrics] ${e instanceof Error ? e.stack : String(e)}\n`);
};
const quote = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`;
const MARK_RE = /(story-metrics\.ts['"]?\s+mark)(?=\s)/g;
const RUN_RE = /(?:^|\s)\S*story-metrics\.ts\s+mark(?:\s|$)/;

/**
 * The command with the caller's identity inserted after every `mark`; null when there is nothing to do. Only a mark
 * call that really runs is touched: when the text also appears in a heredoc, an `echo`, a quoted string or a
 * `node -e` script, the command is left exactly as it is (the marker then records time only).
 */
function rewriteMark(command: string, payload: Record<string, any>): string | null {
  const textual = [...command.matchAll(MARK_RE)];
  if (!textual.length) return null;
  const executed = segments(command).filter((s) => s.head.split("/").pop() === "node" && RUN_RE.test(s.masked));
  if (executed.length !== textual.length) return null;
  if (executed.some((s) => /\s--session(?:\s|=|$)/.test(s.masked))) return null;
  const session = typeof payload.session_id === "string" ? payload.session_id : "";
  if (!session) return null;
  const flags = [`--harness ${payload.harness === "opencode" ? "opencode" : "claude-code"}`, `--session ${quote(session)}`];
  if (typeof payload.agent_id === "string" && payload.agent_id) flags.push(`--agent ${quote(payload.agent_id)}`);
  if (typeof payload.agent_type === "string" && payload.agent_type) flags.push(`--agent-type ${quote(payload.agent_type)}`);
  if (typeof payload.transcript_path === "string" && payload.transcript_path) flags.push(`--transcript ${quote(payload.transcript_path)}`);
  return command.replace(MARK_RE, (m) => `${m} ${flags.join(" ")}`);
}

const CALLER_RE = /((?:worker\.ts['"]?\s+(?:start|report))|(?:marathon-state\.ts['"]?\s+(?:start-run|claim|review|result|escalate|release|resume|finish|status|summary)))(?=\s|$)/g;
const CALLER_RUN_RE = /(?:^|\s)\S*(?:worker\.ts\s+(?:start|report)|marathon-state\.ts\s+[a-z-]+)(?:\s|$)/;

/**
 * The command with `--caller` after every worker/marathon subcommand that really runs; null when there is nothing to
 * do. Same care as `rewriteMark`: text in a heredoc, a string or an `echo` is never touched – then nothing is.
 */
function rewriteCaller(command: string, payload: Record<string, any>): string | null {
  const textual = [...command.matchAll(CALLER_RE)];
  if (!textual.length) return null;
  const executed = segments(command).filter((s) => s.head.split("/").pop() === "node" && CALLER_RUN_RE.test(s.masked));
  if (executed.length !== textual.length) return null;
  if (executed.some((s) => /\s--caller(?:\s|=|$)/.test(s.masked))) return null;
  const caller = callerOf(payload);
  if (!caller) return null;
  return command.replace(CALLER_RE, (m) => `${m} --caller ${quote(caller)}`);
}

const event = String(data.hook_event_name ?? "");
// KATASTER_METRICS_NOW pins the clock – for tests only.
const now = (): string => process.env.KATASTER_METRICS_NOW ?? new Date().toISOString();
const harness = data.harness === "opencode" ? "opencode" : "claude-code";

try {
  if (event === "PreToolUse") {
    const command = data.tool_name === "Bash" ? data.tool_input?.command : undefined;
    const marked = typeof command === "string" ? rewriteMark(command, data) ?? command : null;
    const tagged = marked === null ? null : rewriteCaller(marked, data) ?? marked;
    const next = tagged !== null && tagged !== command ? tagged : null;
    if (next) {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { ...data.tool_input, command: next } } }));
    }
  } else if (event === "PermissionRequest") {
    const m = await import("../lib/metrics.ts");
    m.appendEvent({
      ts: now(),
      harness,
      session: String(data.session_id ?? ""),
      agent: typeof data.agent_id === "string" && data.agent_id ? data.agent_id : "main",
      kind: "permission.asked",
      id: String(data.tool_use_id ?? `${Date.now()}`),
    });
  } else if (event === "KatasterEvent") {
    const m = await import("../lib/metrics.ts");
    const d = (data.data ?? {}) as Record<string, any>;
    const base = { ts: now(), harness: "opencode" as const, agent: "main" };
    const type = String(data.type ?? "");
    if (type === "permission.asked") m.appendEvent({ ...base, session: String(d.sessionID ?? ""), kind: "permission.asked", id: String(d.id ?? "") });
    else if (type === "permission.replied") m.appendEvent({ ...base, session: String(d.sessionID ?? ""), kind: "permission.replied", id: String(d.requestID ?? "") });
    else if (type === "form.created") m.appendEvent({ ...base, session: String(d.form?.sessionID ?? ""), kind: "question.asked", id: String(d.form?.id ?? "") });
    else if (type === "form.replied" || type === "form.cancelled") m.appendEvent({ ...base, session: String(d.sessionID ?? ""), kind: "question.replied", id: String(d.id ?? "") });
  } else if (event === "SessionEnd" || event === "SessionStart") {
    const m = await import("../lib/metrics.ts");
    const { collector } = await import("../lib/metrics-adapters.ts");
    const session = String(data.session_id ?? "");
    const col = await collector();
    if (event === "SessionEnd" && session) m.collectRuns(col, { runs: [session] });
    else m.collectRuns(col, { stale: true, exclude: session ? [session] : [] });
  }
} catch (e) {
  debug(e);
}
process.exit(0);
