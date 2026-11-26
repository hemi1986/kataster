/**
 * PreToolUse hook (Write|Edit|MultiEdit): protects files that must not be edited by hand.
 *
 * - Generated files (BACKLOG.md, event-storming.md) → blocked; they are rendered by hooks and scripts.
 * - Metrics files (docs/stories/metrics/*.json) → blocked; they are append-only and written by story-metrics.ts.
 * - Accepted ADRs are not edited, only superseded. Two changes are allowed:
 *   - `status: accepted` → `status: superseded by ADR-NNNN`, nothing else,
 *   - an editorial change (typo, outdated path, formatting) that keeps `status: accepted`, keeps every earlier entry
 *     of the `## Editorial changes` section and adds at least one entry `- YYYY-MM-DD: <what changed>` to it. The
 *     decision itself never changes this way; a changed decision is a new ADR.
 */
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { rel, ROOT } from "../lib/discovery.ts";

const GENERATED = new Set(["docs/stories/BACKLOG.md", "docs/domain/event-storming.md"]);

let data: Record<string, any>;
try {
  data = JSON.parse(readFileSync(0, "utf8"));
} catch {
  process.exit(0);
}
const ti = data.tool_input ?? {};
const fp: unknown = ti.file_path;
if (typeof fp !== "string" || !fp) process.exit(0);
const path = isAbsolute(fp) ? fp : join(data.cwd || ROOT, fp);
const r = rel(path);

/** The dated entries of the `## Editorial changes` section, in order. */
function editorialEntries(text: string): string[] {
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  const start = lines.findIndex((line) => /^##\s+Editorial changes\s*$/i.test(line));
  if (start === -1) return [];
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,2}\s/.test(line)) break;
    if (/^\s*[-*]\s+\d{4}-\d{2}-\d{2}\s*[:–-]\s*\S/.test(line)) out.push(line.trim());
  }
  return out;
}

/** An editorial change keeps the ADR accepted, keeps the log and adds at least one entry to it. */
function isEditorialChange(old: string, next: string, newStatus: string): boolean {
  if (newStatus !== "accepted") return false;
  const before = editorialEntries(old);
  const after = editorialEntries(next);
  return after.length > before.length && before.every((entry) => after.includes(entry));
}

function block(msg: string): never {
  process.stderr.write(`Blocked: ${msg}\n`);
  process.exit(2);
}

if (GENERATED.has(r)) block(`'${r}' is generated – change its sources (story files, events.yaml) instead.`);
if (/^docs\/stories\/metrics\/[^/]+\.json$/.test(r)) {
  block(`'${r}' is an append-only metrics file – it is written by \`story-metrics.ts mark … end\` and \`collect\`, never by hand.`);
}

if (/^docs\/adr\/\d{4}-.*\.md$/.test(r) && existsSync(path)) {
  const old = readFileSync(path, "utf8");
  if (!/^status:\s*accepted\s*$/m.test(old)) process.exit(0);

  let next: string;
  if (data.tool_name === "Write") {
    next = String(ti.content ?? "");
  } else {
    const edits: { old_string: string; new_string: string; replace_all?: boolean }[] =
      data.tool_name === "MultiEdit" ? ti.edits ?? [] : [ti];
    next = old;
    for (const e of edits) next = e.replace_all ? next.split(e.old_string).join(e.new_string) : next.replace(e.old_string, e.new_string);
  }
  const withoutStatus = (t: string) => t.replace(/^status:.*$/m, "");
  const newStatus = /^status:\s*(.*?)\s*$/m.exec(next)?.[1] ?? "";
  const superseded = withoutStatus(next) === withoutStatus(old) && /^superseded by ADR-\d{4}$/.test(newStatus);
  if (!superseded && !isEditorialChange(old, next, newStatus)) {
    block(
      `'${r}' is an accepted ADR. A changed decision is a new ADR (status: proposed); once the user accepts it, ` +
        "only change this one's status to 'superseded by ADR-NNNN'. An editorial change (typo, outdated path, " +
        "formatting) keeps 'status: accepted' and adds a line '- YYYY-MM-DD: <what changed>' under " +
        "'## Editorial changes'.",
    );
  }
}
process.exit(0);
