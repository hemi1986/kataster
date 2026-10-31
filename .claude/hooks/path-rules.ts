/**
 * Path-scoped rules (`.claude/rules/*.md`) for harnesses without native support.
 *
 * Claude Code reads `.claude/rules/` itself and scopes each rule by its `paths:` frontmatter. OpenCode has no
 * path-scoped rules, so `.opencode/plugins/kataster` calls this script whenever a file is read or written and
 * attaches the matching rules to the session as keyed instruction entries. One source of truth, two harnesses.
 *
 *   echo '{"paths":["libs/shared/src/index.ts"],"cwd":"/repo"}' | node .claude/hooks/path-rules.ts
 *
 * Output: `{"rules":[{"key":"<slug>","value":"<rule body>"}]}` – empty when nothing matches. This hook never
 * blocks; a broken rule must not stop a tool call.
 */
import { readFileSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import { globToRegExp, validateRules } from "../lib/architecture.ts";
import { ROOT } from "../lib/repo.ts";

interface Entry {
  key: string;
  value: string;
}

let data: Record<string, unknown>;
try {
  data = JSON.parse(readFileSync(0, "utf8"));
} catch {
  process.exit(0);
}

const root = typeof data.cwd === "string" && data.cwd ? data.cwd : ROOT;
const raw = Array.isArray(data.paths)
  ? data.paths
  : data.tool_input && typeof data.tool_input === "object" && typeof (data.tool_input as Record<string, unknown>).file_path === "string"
    ? [(data.tool_input as Record<string, unknown>).file_path]
    : [];

const files = raw
  .filter((p): p is string => typeof p === "string" && p.length > 0)
  .map((p) => toRepoPath(root, p))
  .filter((p): p is string => p !== undefined);
if (!files.length) fail();

const { rules } = validateRules(root);
const matched: Entry[] = [];
for (const rule of rules) {
  if (!rule.paths.some((glob) => files.some((file) => globToRegExp(glob).test(file)))) continue;
  const key = rule.path.replace(/^\.claude\/rules\//, "").replace(/\.md$/, "").replaceAll("/", "-");
  const scope = `Applies to ${rule.paths.map((p) => `\`${p}\``).join(", ")}.`;
  matched.push({ key, value: `${scope}\n\n${rule.body}` });
}

process.stdout.write(JSON.stringify({ rules: matched }));
process.exit(0);

/** Repository-relative POSIX path, or undefined when the file is outside the repository. */
function toRepoPath(root: string, path: string): string | undefined {
  const rel = isAbsolute(path) ? relative(root, path) : path;
  const posix = rel.split(sep).join("/").replace(/^\.\//, "");
  if (!posix || posix.startsWith("../") || posix === ".." || isAbsolute(posix)) return undefined;
  return posix;
}

function fail(): never {
  process.stdout.write(JSON.stringify({ rules: [] }));
  process.exit(0);
}
