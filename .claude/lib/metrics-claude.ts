/**
 * Claude Code adapter for the story metrics.
 *
 * Sources (verified against Claude Code 2.1.x):
 *   - main session:  `~/.claude/projects/<project>/<session>.jsonl` (the hooks' `transcript_path`)
 *   - subagents:     `<session>/subagents/agent-<id>.jsonl` next to it, with `agent-<id>.meta.json`
 *                    (`agentType`, `toolUseId` – the Agent call that started it, in the parent's transcript)
 *
 * Usage lives on `type: "assistant"` lines in `message.usage`. One API response is written as several lines (one per
 * content block) that repeat the same `message.id` and usage – they are merged by id, taking the largest value per
 * field, so a response is counted once. `output_tokens` already contains the thinking tokens
 * (`output_tokens_details.thinking_tokens` is a breakdown, never larger); `cache_creation_input_tokens` contains the
 * 1-hour part (`cache_creation.ephemeral_1h_input_tokens`).
 *
 * Waits for the user:
 *   - a question: `AskUserQuestion` tool_use → its tool_result
 *   - the end of a turn: the last assistant/system line → the next line the user typed (not a tool_result, not meta)
 *   - a permission prompt: the `PermissionRequest` hook logs `permission.asked`; it ends at the next transcript line
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Adapter, Interval, Stream, Tokens, UsageMessage, WaitEvent } from "./metrics.ts";
import { eventWaits, streamKey } from "./metrics.ts";

type Line = Record<string, any>;

function readLines(path: string): Line[] {
  const out: Line[] = [];
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    if (!raw.trim()) continue;
    try {
      out.push(JSON.parse(raw) as Line);
    } catch {
      // the last line may be half-written while the session runs
    }
  }
  return out;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Normalised tokens of one `message.usage`. */
export function claudeTokens(usage: Line): Tokens {
  const thinking = num(usage.output_tokens_details?.thinking_tokens);
  const output = num(usage.output_tokens);
  return {
    input: num(usage.input_tokens),
    output,
    reasoning: Math.min(thinking, output),
    cacheRead: num(usage.cache_read_input_tokens),
    cacheWrite: num(usage.cache_creation_input_tokens),
    cacheWrite1h: Math.min(num(usage.cache_creation?.ephemeral_1h_input_tokens), num(usage.cache_creation_input_tokens)),
  };
}

const maxTokens = (a: Tokens, b: Tokens): Tokens => ({
  input: Math.max(a.input, b.input),
  output: Math.max(a.output, b.output),
  reasoning: Math.max(a.reasoning, b.reasoning),
  cacheRead: Math.max(a.cacheRead, b.cacheRead),
  cacheWrite: Math.max(a.cacheWrite, b.cacheWrite),
  cacheWrite1h: Math.max(a.cacheWrite1h, b.cacheWrite1h),
});

const isToolResult = (content: unknown): boolean => Array.isArray(content) && content.some((b) => b?.type === "tool_result");

/** A line the user produced: a prompt or a local command – not a tool result, not injected meta text. */
function isUserInput(line: Line): boolean {
  if (line.type !== "user" || line.isMeta === true || line.isCompactSummary === true) return false;
  const content = line.message?.content;
  if (isToolResult(content)) return false;
  return typeof content === "string" ? content.trim() !== "" : Array.isArray(content) && content.length > 0;
}

interface Parsed {
  messages: UsageMessage[];
  waits: Interval[];
  activity: number[];
  toolUseIds: Set<string>;
}

export function parseTranscript(path: string): Parsed {
  const lines = readLines(path).filter((l) => typeof l.timestamp === "string");
  lines.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  const byId = new Map<string, UsageMessage>();
  const asks = new Map<string, number>();
  const waits: Interval[] = [];
  const toolUseIds = new Set<string>();
  const activity: number[] = [];
  let lastAgent: number | null = null;

  for (const line of lines) {
    const ts = Date.parse(line.timestamp);
    if (!Number.isFinite(ts)) continue;
    activity.push(ts);
    if (line.type === "assistant") {
      lastAgent = ts;
      const m = line.message ?? {};
      for (const block of Array.isArray(m.content) ? m.content : []) {
        if (block?.type !== "tool_use" || typeof block.id !== "string") continue;
        toolUseIds.add(block.id);
        if (block.name === "AskUserQuestion") asks.set(block.id, ts);
      }
      if (!m.usage || m.model === "<synthetic>") continue;
      const id = typeof m.id === "string" ? m.id : `${line.uuid ?? ts}`;
      const tokens = claudeTokens(m.usage);
      const prev = byId.get(id);
      byId.set(id, {
        id,
        ts: Math.max(prev?.ts ?? 0, ts),
        model: typeof m.model === "string" ? m.model : prev?.model ?? null,
        provider: "anthropic",
        tokens: prev ? maxTokens(prev.tokens, tokens) : tokens,
        harnessCostUsd: null,
      });
      continue;
    }
    if (line.type === "system") {
      lastAgent = ts;
      continue;
    }
    if (line.type !== "user") continue;
    const content = line.message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type !== "tool_result") continue;
        const asked = asks.get(block.tool_use_id);
        if (asked !== undefined && ts > asked) waits.push([asked, ts]);
      }
    }
    if (isUserInput(line)) {
      if (lastAgent !== null && ts > lastAgent) waits.push([lastAgent, ts]);
      lastAgent = null;
    }
  }
  return { messages: [...byId.values()].sort((a, b) => a.ts - b.ts), waits, activity, toolUseIds };
}

function claudeDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
}

/** The main transcript of a session: the path the hook gave, or a search under `~/.claude/projects/`. */
export function findTranscript(session: string, hint?: string): string | null {
  if (hint && existsSync(hint)) return hint;
  const projects = join(claudeDir(), "projects");
  if (!existsSync(projects)) return null;
  for (const dir of readdirSync(projects)) {
    const candidate = join(projects, dir, `${session}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

interface SubagentFile {
  id: string;
  path: string;
  agentType: string;
  toolUseId: string | null;
}

function subagentFiles(transcript: string): SubagentFile[] {
  const dir = join(transcript.replace(/\.jsonl$/, ""), "subagents");
  if (!existsSync(dir)) return [];
  const out: SubagentFile[] = [];
  for (const name of readdirSync(dir)) {
    const m = /^agent-(.+)\.jsonl$/.exec(name);
    if (!m) continue;
    let meta: Line = {};
    try {
      meta = JSON.parse(readFileSync(join(dir, `agent-${m[1]}.meta.json`), "utf8")) as Line;
    } catch {
      // older versions wrote no meta file
    }
    out.push({ id: m[1], path: join(dir, name), agentType: typeof meta.agentType === "string" ? meta.agentType : "subagent", toolUseId: typeof meta.toolUseId === "string" ? meta.toolUseId : null });
  }
  return out;
}

export function claudeAdapter(): Adapter {
  return {
    harness: "claude-code",
    locate: (session, agent) => ({ run: session, agent: agent || "main" }),

    load(run, hint, events: WaitEvent[]): Stream[] {
      const transcript = findTranscript(run, hint.transcript);
      if (!transcript) throw new Error(`transcript of session ${run} not found`);
      const mine = events.filter((e) => e.harness === "claude-code" && e.session === run);
      const make = (agent: string, agentType: string, parsed: Parsed, parent: string | null): Stream => {
        const waits = [...parsed.waits, ...eventWaits(mine, (e) => (e.agent || "main") === agent, parsed.activity)];
        return {
          key: streamKey("claude-code", run, agent),
          harness: "claude-code",
          run,
          session: run,
          agent,
          agentType,
          parent,
          messages: parsed.messages,
          waits,
          first: parsed.activity[0] ?? 0,
          last: parsed.activity[parsed.activity.length - 1] ?? 0,
          activity: parsed.activity,
        };
      };
      const mainParsed = parseTranscript(transcript);
      const main = make("main", "main", mainParsed, null);
      const subs = subagentFiles(transcript).map((f) => ({ f, parsed: parseTranscript(f.path) }));
      // A subagent's parent is the stream whose transcript holds the Agent call that started it (nested workers).
      const owner = (toolUseId: string | null): string => {
        if (!toolUseId || mainParsed.toolUseIds.has(toolUseId)) return main.key;
        const parent = subs.find((s) => s.parsed.toolUseIds.has(toolUseId));
        return parent ? streamKey("claude-code", run, parent.f.id) : main.key;
      };
      return [main, ...subs.map(({ f, parsed }) => make(f.id, f.agentType, parsed, owner(f.toolUseId)))];
    },

    lastActivity(run, hint) {
      const transcript = findTranscript(run, hint.transcript);
      if (!transcript) return null;
      let last = statSync(transcript).mtimeMs;
      for (const f of subagentFiles(transcript)) last = Math.max(last, statSync(f.path).mtimeMs);
      return last;
    },
  };
}
