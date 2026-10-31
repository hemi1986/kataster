/**
 * PreToolUse hook for subagents: only allows writes below the given path prefixes.
 *
 * Usage: node path-guard.ts docs/stories/ docs/reviews/
 */
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { rel, ROOT } from "../lib/discovery.ts";

const allowed = process.argv.slice(2).map((a) => a.replace(/^\/+|\/+$/g, ""));

let data: Record<string, any>;
try {
  data = JSON.parse(readFileSync(0, "utf8"));
} catch {
  process.exit(0);
}
const ti = data.tool_input ?? {};
const fp: unknown = ti.file_path ?? ti.notebook_path;
if (typeof fp !== "string" || !fp) process.exit(0);

const path = isAbsolute(fp) ? fp : join(data.cwd || ROOT, fp);
const r = rel(path); // unchanged absolute path = outside the project
if (r === path) {
  process.stderr.write(`Blocked: '${fp}' is outside the project.\n`);
  process.exit(2);
}
if (allowed.some((a) => r === a || r.startsWith(a + "/"))) process.exit(0);

process.stderr.write(
  `Blocked: this agent may not write '${r}'. Allowed: ${allowed.join(", ")}. ` +
    "Report the requested change back to the main session instead.\n",
);
process.exit(2);
