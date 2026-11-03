/**
 * The story spec linter – deterministic, no LLM, no tokens.
 *
 * It is the gate before `ready-for-human-review`: a story only leaves `review` when this exits 0.
 * The rules live in `lib/discovery.ts`, so the PostToolUse hook, `validate-stories.ts`, `story-status.ts`
 * and `verify.ts` all enforce the same checks. This script is the human/CI entry point.
 *
 *   node .claude/skills/user-stories/scripts/lint-story.ts            # every story
 *   node .claude/skills/user-stories/scripts/lint-story.ts ST-012     # one story by id
 *   node .claude/skills/user-stories/scripts/lint-story.ts docs/stories/ST-012-*.md
 *   node .claude/skills/user-stories/scripts/lint-story.ts --json     # machine-readable
 *
 * Checks: frontmatter syntax and required fields (`id`, `title`, `type`, `status`; `aggregate` and `command`
 * for `type: domain`), referential integrity against `docs/domain/events.yaml` (aggregate, command, events =
 * what the command produces), Gherkin Given/When/Then, at most 4 scenarios, unique scenario titles.
 */
import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import * as d from "../../../lib/discovery.ts";

const args = process.argv.slice(2);
const json = args.includes("--json");
const target = args.find((a) => !a.startsWith("-"));

let only: string | null = null;
if (target) {
  if (/^ST-\d{3,}$/i.test(target)) {
    const path = d.storyFiles().find((f) => basename(f).toUpperCase().startsWith(target.toUpperCase()));
    if (!path) {
      console.error(`No story file found for '${target}' in docs/stories/.`);
      process.exit(1);
    }
    only = path;
  } else {
    only = resolve(target);
    if (!existsSync(only)) {
      console.error(`Story file not found: ${target}`);
      process.exit(1);
    }
  }
}

const report = new d.Report();
d.validateStories(report, only);

if (json) {
  console.log(JSON.stringify({ ok: report.ok, errors: report.errors, warnings: report.warnings }, null, 2));
} else {
  for (const line of report.lines()) console.log(line);
  if (report.ok) {
    console.log(`Spec linter OK${only ? ` – ${d.rel(only)}` : ""}${report.warnings.length ? ` (${report.warnings.length} warning(s))` : ""}.`);
  } else {
    console.log(`\nSpec linter FAILED: ${report.errors.length} error(s). Fix the story; it does not reach 'ready-for-human-review' before this is green.`);
  }
}
process.exit(report.ok ? 0 : 1);
