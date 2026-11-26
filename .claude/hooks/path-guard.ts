/**
 * PreToolUse hook for subagents: limits where an agent may write.
 *
 *   node path-guard.ts docs/stories/ docs/reviews/     only below these path prefixes
 *   node path-guard.ts --deny CONTEXT.md docs/adr/     everywhere in the project except these files and prefixes
 */
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { rel, ROOT } from "../lib/discovery.ts";

const argv = process.argv.slice(2);
const deny = argv[0] === "--deny";
const prefixes = (deny ? argv.slice(1) : argv).map((a) => a.replace(/^\/+|\/+$/g, ""));

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
const listed = prefixes.some((a) => r === a || r.startsWith(a + "/"));
if (listed !== deny) process.exit(0);

process.stderr.write(
  `Blocked: this agent may not write '${r}'. ${deny ? "Not its to change" : "Allowed"}: ${prefixes.join(", ")}. ` +
    "Report the requested change back to the main session instead.\n",
);
process.exit(2);
