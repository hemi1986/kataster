/**
 * PreToolUse hook (Write|Edit|MultiEdit): protects files that must not be edited by hand.
 *
 * - Generated files (BACKLOG.md, event-storming.md) → blocked; they are rendered by hooks and scripts.
 * - Accepted ADRs are never edited, only superseded: the only change allowed is
 *   `status: accepted` → `status: superseded by ADR-NNNN`.
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

function block(msg: string): never {
  process.stderr.write(`Blocked: ${msg}\n`);
  process.exit(2);
}

if (GENERATED.has(r)) block(`'${r}' is generated – change its sources (story files, events.yaml) instead.`);

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
  if (withoutStatus(next) !== withoutStatus(old) || !/^superseded by ADR-\d{4}$/.test(newStatus)) {
    block(
      `'${r}' is an accepted ADR. Accepted ADRs are never edited – write a new ADR (status: proposed) and, ` +
        "once the user accepts it, only change this one's status to 'superseded by ADR-NNNN'.",
    );
  }
}
process.exit(0);
