/**
 * PostToolUse hook (Write|Edit|MultiEdit): formats and lints the changed application file right away.
 *
 * Runs Prettier and ESLint (--fix) from the app's node_modules on that one file, if they are installed.
 * Remaining lint errors (incl. module boundary violations) are returned to Claude (exit 2).
 * Tooling in .claude/ and docs are not application code and are skipped.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { rel, ROOT } from "../lib/discovery.ts";
import { appBin, isCode } from "../lib/engineering.ts";

let data: Record<string, any>;
try {
  data = JSON.parse(readFileSync(0, "utf8"));
} catch {
  process.exit(0);
}
const fp: unknown = data.tool_input?.file_path;
if (typeof fp !== "string" || !fp) process.exit(0);
const r = rel(isAbsolute(fp) ? fp : join(data.cwd || ROOT, fp));
if (r.startsWith("/") || r.startsWith(".claude/") || r.startsWith("docs/")) process.exit(0);

const prettier = appBin("prettier");
if (prettier && /\.(ts|tsx|js|jsx|mjs|cjs|json|css|md)$/.test(r) && !r.startsWith("docs/")) {
  spawnSync(prettier, ["--write", "--log-level", "warn", r], { cwd: ROOT, timeout: 30_000 });
}
const eslint = appBin("eslint");
if (eslint && isCode(r)) {
  const res = spawnSync(eslint, ["--fix", "--no-warn-ignored", r], { cwd: ROOT, encoding: "utf8", timeout: 60_000 });
  if (res.status === 1) {
    process.stderr.write(`ESLint errors in ${r} – please fix:\n${(res.stdout + res.stderr).trim()}\n`);
    process.exit(2);
  }
}
process.exit(0);
