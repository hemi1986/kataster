/**
 * OpenCode adapter for the story metrics.
 *
 * Source: OpenCode's SQLite database (`$XDG_DATA_HOME/opencode/opencode.db`, override with `KATASTER_OPENCODE_DB`),
 * opened read-only through `node:sqlite`. Verified against OpenCode 2.4:
 *
 *   v2 (current)  session_v2(id, parent_id, agent, …)   – child sessions are subagents (`parent_id`)
 *                 session_message(id, session_id, type, time_created, data)
 *                   type `assistant`: data.tokens {input, output, reasoning, cache{read, write}}, data.cost,
 *                                     data.model {id, providerID}, data.time {created, completed}
 *                   type `user` / `idle`: a prompt / the end of a turn
 *                 session_part(…, type `tool`, data.name `question`) – a question, start/end in time_created/updated
 *   v1 (legacy)   session(id, parent_id), message(id, session_id, time_created, data{role, tokens, modelID, …}),
 *                 part(…, data{type: "tool", tool: "question"})
 *
 * OpenCode reports `reasoning` *beside* `output` (its own context total is input + output + reasoning + cache), so the
 * normalised `output` is `output + reasoning` and `reasoning` is kept as its breakdown – the same meaning as Claude's
 * `output_tokens` with `thinking_tokens`. OpenCode's cache write has no TTL split (`cacheWrite1h` stays 0). Its
 * `cost` is kept as `harnessCostUsd`; it is 0 for subscription providers, so the report prices tokens itself.
 *
 * Waits: an `idle` row up to the next `user` row; questions and permission prompts from the event log the plugin
 * writes (`form.*`, `permission.*`), with the `question` tool parts as a fallback when no event was logged.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Adapter, Interval, Stream, Tokens, UsageMessage, WaitEvent } from "./metrics.ts";
import { eventWaits, streamKey } from "./metrics.ts";

type Row = Record<string, any>;
interface Db {
  prepare(sql: string): { all(...params: unknown[]): unknown[]; get(...params: unknown[]): unknown };
  close(): void;
}
type DbCtor = new (path: string, options?: { readOnly?: boolean }) => Db;

export function openCodeDbPath(): string {
  if (process.env.KATASTER_OPENCODE_DB) return process.env.KATASTER_OPENCODE_DB;
  const data = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(data, "opencode", "opencode.db");
}

/** `node:sqlite` without its experimental warning on Node 22/23. */
async function loadSqlite(): Promise<DbCtor> {
  const original = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const type = typeof rest[0] === "string" ? rest[0] : (rest[0] as { type?: string } | undefined)?.type;
    if (type === "ExperimentalWarning" && String(warning).includes("SQLite")) return;
    return (original as (...a: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    return (await import("node:sqlite")).DatabaseSync as unknown as DbCtor;
  } finally {
    process.emitWarning = original;
  }
}

export type Schema = "v2" | "v1";

const V2: Record<string, string[]> = {
  session_v2: ["id", "parent_id", "agent"],
  session_message: ["id", "session_id", "type", "time_created", "time_updated", "data"],
};
const V1: Record<string, string[]> = {
  session: ["id", "parent_id"],
  message: ["id", "session_id", "time_created", "time_updated", "data"],
};

function columns(db: Db, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all() as Row[]).map((r) => String(r.name)));
}
function missing(db: Db, spec: Record<string, string[]>): string[] {
  const out: string[] = [];
  for (const [table, cols] of Object.entries(spec)) {
    const have = columns(db, table);
    if (!have.size) out.push(`table ${table}`);
    else for (const c of cols) if (!have.has(c)) out.push(`${table}.${c}`);
  }
  return out;
}

/** Which schema the database has; throws with what is missing when it is neither. */
export function detectSchema(db: Db, path: string): Schema {
  const v2 = missing(db, V2);
  if (!v2.length) return "v2";
  const v1 = missing(db, V1);
  if (!v1.length) return "v1";
  throw new Error(
    `OpenCode database ${path} has an unknown schema – expected the v2 tables (missing: ${v2.join(", ")}) ` +
      `or the legacy tables (missing: ${v1.join(", ")}). The OpenCode storage format changed; update ` +
      "`.claude/lib/metrics-opencode.ts`, or point KATASTER_OPENCODE_DB at the right file.",
  );
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const json = (text: unknown): Row => {
  try {
    return JSON.parse(String(text)) as Row;
  } catch {
    return {};
  }
};

/** Normalised tokens of one OpenCode `tokens` object (reasoning folded into output, see the header). */
export function openCodeTokens(t: Row | undefined): Tokens {
  const reasoning = num(t?.reasoning);
  return {
    input: num(t?.input),
    output: num(t?.output) + reasoning,
    reasoning,
    cacheRead: num(t?.cache?.read),
    cacheWrite: num(t?.cache?.write),
    cacheWrite1h: 0,
  };
}

interface Tables {
  session: string;
  message: string;
  part: string | null;
}

export async function openCodeAdapter(path = openCodeDbPath()): Promise<Adapter> {
  const DatabaseSync = await loadSqlite();
  let db: Db | null = null;
  let schema: Schema | null = null;
  let tables: Tables | null = null;
  const open = (): { db: Db; schema: Schema; tables: Tables } => {
    if (!db) {
      if (!existsSync(path)) throw new Error(`OpenCode database not found at ${path} (set KATASTER_OPENCODE_DB)`);
      db = new DatabaseSync(path, { readOnly: true });
      schema = detectSchema(db, path);
      const partTable = schema === "v2" ? "session_part" : "part";
      const partCols = columns(db, partTable);
      tables = {
        session: schema === "v2" ? "session_v2" : "session",
        message: schema === "v2" ? "session_message" : "message",
        part: ["session_id", "time_created", "time_updated", "data"].every((c) => partCols.has(c)) ? partTable : null,
      };
    }
    return { db, schema: schema!, tables: tables! };
  };

  const sessionRow = (id: string): Row | undefined => {
    const { db, tables } = open();
    return db.prepare(`SELECT * FROM ${tables.session} WHERE id = ?`).get(id) as Row | undefined;
  };
  const children = (id: string): Row[] => {
    const { db, tables } = open();
    return db.prepare(`SELECT * FROM ${tables.session} WHERE parent_id = ? ORDER BY time_created`).all(id) as Row[];
  };
  const rootOf = (id: string): string => {
    let current = id;
    for (let guard = 0; guard < 50; guard++) {
      const row = sessionRow(current);
      if (!row) throw new Error(`OpenCode session ${current} not found in ${path}`);
      if (!row.parent_id) return current;
      current = String(row.parent_id);
    }
    return current;
  };
  const tree = (run: string): { id: string; parent: string | null; agentType: string }[] => {
    const out: { id: string; parent: string | null; agentType: string }[] = [{ id: run, parent: null, agentType: "main" }];
    for (let i = 0; i < out.length; i++) {
      for (const c of children(out[i].id)) out.push({ id: String(c.id), parent: out[i].id, agentType: typeof c.agent === "string" && c.agent ? c.agent : "" });
    }
    return out;
  };

  function streamOf(run: string, node: { id: string; parent: string | null; agentType: string }, events: WaitEvent[]): Stream {
    const { db, schema, tables } = open();
    const rows = db.prepare(`SELECT id, time_created, time_updated, data${schema === "v2" ? ", type" : ""} FROM ${tables.message} WHERE session_id = ? ORDER BY time_created, id`).all(node.id) as Row[];
    const messages: UsageMessage[] = [];
    const seen = new Set<string>();
    const waits: Interval[] = [];
    const activity: number[] = [];
    let waitingSince: number | null = null;
    let agentType = node.agentType;
    for (const row of rows) {
      const data = json(row.data);
      const kind = schema === "v2" ? String(row.type) : String(data.role ?? "");
      const created = num(data.time?.created) || num(row.time_created);
      const completed = num(data.time?.completed) || created;
      activity.push(created);
      if (completed !== created) activity.push(completed);
      if (kind === "assistant") {
        if (!agentType) agentType = String(data.agent ?? data.mode ?? "");
        if (schema === "v1") waitingSince = completed;
        else waitingSince = null;
        const id = String(row.id);
        if (seen.has(id)) continue;
        seen.add(id);
        const model = schema === "v2" ? data.model?.id : data.modelID;
        const provider = schema === "v2" ? data.model?.providerID : data.providerID;
        messages.push({
          id,
          ts: completed,
          model: typeof model === "string" ? model : null,
          provider: typeof provider === "string" ? provider : null,
          tokens: openCodeTokens(data.tokens),
          harnessCostUsd: typeof data.cost === "number" ? data.cost : null,
        });
      } else if (kind === "idle") {
        waitingSince = created;
      } else if (kind === "user") {
        if (waitingSince !== null && created > waitingSince) waits.push([waitingSince, created]);
        waitingSince = null;
      } else if (kind === "synthetic") {
        waitingSince = null;
      }
    }
    activity.sort((a, b) => a - b);

    const mine = events.filter((e) => e.harness === "opencode" && e.session === node.id);
    waits.push(...eventWaits(mine, () => true, activity));
    if (!mine.some((e) => e.kind === "question.asked") && tables.part) {
      const parts = db.prepare(`SELECT time_created, time_updated, data FROM ${tables.part} WHERE session_id = ?`).all(node.id) as Row[];
      for (const p of parts) {
        const d = json(p.data);
        if (d.type !== "tool" || (d.name ?? d.tool) !== "question") continue;
        const start = num(d.time?.start ?? d.state?.time?.start) || num(p.time_created);
        const end = num(d.time?.end ?? d.state?.time?.end) || num(p.time_updated);
        if (end > start) waits.push([start, end]);
      }
    }
    const agent = node.parent === null ? "main" : node.id;
    return {
      key: streamKey("opencode", run, agent),
      harness: "opencode",
      run,
      session: node.id,
      agent,
      agentType: node.parent === null ? "main" : agentType || "subagent",
      parent: node.parent === null ? null : streamKey("opencode", run, node.parent === run ? "main" : node.parent),
      messages: messages.sort((a, b) => a.ts - b.ts),
      waits,
      first: activity[0] ?? 0,
      last: activity[activity.length - 1] ?? 0,
      activity,
    };
  }

  return {
    harness: "opencode",
    locate(session) {
      const run = rootOf(session);
      return { run, agent: run === session ? "main" : session };
    },
    load(run, _hint, events) {
      return tree(run).map((node) => streamOf(run, node, events));
    },
    lastActivity(run) {
      const { db, tables } = open();
      const ids = tree(run).map((n) => n.id);
      const row = db.prepare(`SELECT MAX(time_updated) AS last FROM ${tables.message} WHERE session_id IN (${ids.map(() => "?").join(",")})`).get(...ids) as Row | undefined;
      return row?.last ? num(row.last) : null;
    },
  };
}
