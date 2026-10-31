/**
 * Scaffolds and validates `.claude/rules/*.md` – path-scoped rules with `paths:` frontmatter.
 *
 *   node .claude/skills/adopt/scripts/rule-doc.ts libs-shared --paths "libs/**" --title "Shared libraries"
 *   node .claude/skills/adopt/scripts/rule-doc.ts --check
 *   node .claude/skills/adopt/scripts/rule-doc.ts --list
 *
 * A rule for a whole directory should be `<dir>/AGENTS.md` instead – that is the mechanism both harnesses load
 * on demand. `.claude/rules/` is for patterns a directory cannot express (e.g. every SQL file). Claude Code reads
 * these files natively; OpenCode's plugin injects a matching rule when a file under its `paths:` is touched.
 */
import { relPath, validateRules, writeRule } from "../../../lib/architecture.ts";
import { ROOT } from "../../../lib/repo.ts";

const args = process.argv.slice(2);

function usage(): void {
  console.log(
    [
      "Usage: node .claude/skills/adopt/scripts/rule-doc.ts <slug> --paths <glob> [--paths <glob>] [--title <title>]",
      "       node .claude/skills/adopt/scripts/rule-doc.ts --check",
      "       node .claude/skills/adopt/scripts/rule-doc.ts --list",
    ].join("\n"),
  );
}

if (args.includes("--help") || args.includes("-h")) {
  usage();
  process.exit(0);
}

if (args.includes("--check")) {
  const { rules, errors } = validateRules(ROOT);
  for (const error of errors) console.error(`ERROR ${error}`);
  if (errors.length) process.exit(1);
  console.log(`OK – ${rules.length} rule file${rules.length === 1 ? "" : "s"} valid.`);
  process.exit(0);
}

if (args.includes("--list")) {
  const { rules, errors } = validateRules(ROOT);
  for (const rule of rules) console.log(`${rule.path}: ${rule.paths.join(", ")} – ${rule.title}`);
  if (errors.length) {
    for (const error of errors) console.error(`ERROR ${error}`);
    process.exit(1);
  }
  process.exit(0);
}

const slug = args.find((arg) => !arg.startsWith("--"));
if (!slug) {
  usage();
  process.exit(1);
}

const paths: string[] = [];
for (let i = 0; i < args.length; i += 1) {
  if (args[i] !== "--paths") continue;
  const value = args[i + 1];
  if (!value || value.startsWith("--")) {
    console.error("--paths needs a glob, e.g. --paths \"libs/**\"");
    process.exit(1);
  }
  paths.push(...value.split(",").map((p) => p.trim()).filter(Boolean));
}

const titleIndex = args.indexOf("--title");
const fallbackTitle = slug.replaceAll("-", " ").replace(/^\w/, (c) => c.toUpperCase());
const title = titleIndex !== -1 && args[titleIndex + 1] && !args[titleIndex + 1].startsWith("--")
  ? args[titleIndex + 1]
  : fallbackTitle;

try {
  const path = writeRule(ROOT, slug, paths, title);
  console.log(`Created ${relPath(ROOT, path)}.`);
  console.log("Fill the rule body during the grilling; one rule per file, and name its enforcement point.");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
