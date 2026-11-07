/**
 * Writes a path-scoped domain document for a concept slice that crosses packages or layers.
 *
 *   node .claude/skills/adopt/scripts/slice-doc.ts order \
 *     --context BC-Order \
 *     --paths "src/api/order*,src/services/order*,src/repositories/order*" \
 *     --title "Order"
 *
 * The file lands in `.claude/rules/<slug>.md` with `paths:` frontmatter. Claude Code scopes it natively;
 * OpenCode's plugin attaches it when a matching file is read or written. A real domain package still gets
 * `<package>/AGENTS.md` through package-doc.ts – this command is for the cross-cutting case, not a duplicate.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { relPath } from "../../../lib/architecture.ts";
import { ROOT } from "../../../lib/repo.ts";

const args = process.argv.slice(2);

function usage(): void {
  console.log(
    [
      "Usage: node .claude/skills/adopt/scripts/slice-doc.ts <slug> --paths <glob> [--paths <glob>] [--context BC-…] [--title <title>]",
      "",
      "Creates .claude/rules/<slug>.md for a concept slice that crosses packages or layers.",
    ].join("\n"),
  );
}

if (args.includes("--help") || args.includes("-h")) {
  usage();
  process.exit(0);
}

const slug = args.find((arg) => !arg.startsWith("--"));
const paths: string[] = [];
let context = "";
let title = "";
for (let i = 0; i < args.length; i += 1) {
  const take = (): string | undefined => {
    const value = args[i + 1];
    if (!value || value.startsWith("--")) return undefined;
    i += 1;
    return value;
  };
  if (args[i] === "--paths") {
    const value = take();
    if (value) paths.push(...value.split(",").map((p) => p.trim()).filter(Boolean));
  } else if (args[i] === "--context") {
    context = take() ?? context;
  } else if (args[i] === "--title") {
    title = take() ?? title;
  }
}

if (!slug || !/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
  console.error("The slug must be kebab-case (a-z, 0-9, -).");
  process.exit(1);
}
if (!paths.length) {
  console.error("At least one --paths glob is required.");
  process.exit(1);
}

const path = join(ROOT, ".claude", "rules", `${slug}.md`);
if (existsSync(path)) {
  console.error(`${relPath(ROOT, path)} already exists – edit it instead of overwriting.`);
  process.exit(1);
}

const heading = title || slug.replaceAll("-", " ").replace(/^\w/, (c) => c.toUpperCase());
const frontmatter = `paths:\n${paths.map((p) => `  - ${JSON.stringify(p)}`).join("\n")}`;
const contextLine = context ? ` (${context})` : "";
const content = [
  "---",
  frontmatter,
  "---",
  "",
  `# ${heading}${contextLine}`,
  "",
  `> Concept slice across layers. Recovered by \`/adopt\`; the target boundary lives in \`docs/domain/context-map.md\`.`,
  "",
  "## Purpose",
  "",
  "[OPEN] Why does this concept exist? One or two sentences, in the domain's words.",
  "",
  "## Key terms",
  "",
  "[OPEN] The terms from `CONTEXT.md` this slice owns or changes; aggregate IDs from `docs/domain/events.yaml`.",
  "",
  "## As-is boundary",
  "",
  "[OPEN] Tables, service methods, entry points and paths that hold this slice together today. Evidence, not guesses.",
  "",
  "## Boundaries",
  "",
  "- May change: [OPEN]",
  "- Must not change: [OPEN]",
  "- Cross-context communication: only through published contracts or events.",
  "",
  "## Typical pitfalls",
  "",
  "[OPEN] What breaks here? From tests, incidents and git history – not guesses.",
  "",
  "## Read next",
  "",
  "- `docs/architecture/repo-map.md`",
  "- `CONTEXT.md`",
  "- `docs/domain/events.yaml`",
  "- `docs/domain/context-map.md` and `docs/domain/context-map.as-is.md`",
  "",
].join("\n");

mkdirSync(dirname(path), { recursive: true });
writeFileSync(path, content, "utf8");
console.log(`Created ${relPath(ROOT, path)}.`);
console.log("Fill the [OPEN] sections during the grilling – do not invent domain meaning.");
