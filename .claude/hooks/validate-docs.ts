/**
 * PostToolUse hook: validates discovery artifacts right after every write.
 *
 * - docs/domain/events.yaml → schema + references; on success event-storming.md and BACKLOG.md are re-rendered
 * - docs/stories/*.md       → the same deterministic rules as `skills/user-stories/scripts/lint-story.ts`
 *                             (frontmatter, aggregate/command/events, Gherkin, scenario limit) and the status change
 *                             since the last commit (engineering workflow); on success BACKLOG.md is re-rendered
 * - docs/research/*.md      → format and expiry metadata (README and `_`-prefixed files are skipped)
 * Exit 2 + stderr = Claude gets the errors back and has to fix them.
 */
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import * as d from "../lib/discovery.ts";
import * as e from "../lib/engineering.ts";
import * as research from "../lib/research.ts";
import { writeGapRegister } from "../lib/gaps.ts";

let data: d.Obj;
try {
  data = JSON.parse(readFileSync(0, "utf8"));
} catch {
  process.exit(0);
}

const fp: unknown = data.tool_input?.file_path;
if (typeof fp !== "string" || !fp) process.exit(0);
const path = isAbsolute(fp) ? fp : join(data.cwd || d.ROOT, fp);
const rel = d.rel(path);

const report = new d.Report();
if (rel === "docs/domain/events.yaml") {
  const model = d.validateEvents(report);
  if (report.ok && model !== null) {
    d.writeEventStormingMd(model);
    d.writeBacklogMd();
    try {
      // Keep an existing register in sync; never create one for a project that has not adopted anything.
      writeGapRegister({ onlyIfExists: true });
    } catch {
      // a broken register never blocks a model write
    }
  }
} else if (d.storyFiles().some((f) => d.realPath(f) === d.realPath(path))) {
  const stories = d.validateStories(report, path, true);
  // Status workflow: compared with the last commit, the new status must be reachable and its preconditions met
  const story = [...stories.values()].find((s) => d.realPath(s.path) === d.realPath(path));
  const from = story ? e.headStatus(story) : null;
  if (story && from !== null) {
    for (const msg of e.transitionErrors(story, from, String(story.meta.status), stories)) report.error(rel, msg);
  }
  if (report.ok) d.writeBacklogMd();
} else if (rel.startsWith("docs/research/") && rel.endsWith(".md")) {
  const name = rel.split("/").pop() ?? "";
  if (name === "README.md" || name.startsWith("_")) process.exit(0);
  const validation = research.validateResearchFile(path);
  for (const error of validation.errors) report.error(rel, error);
  for (const warning of validation.warnings) report.warn(rel, warning);
} else {
  process.exit(0);
}

if (!report.ok) {
  process.stderr.write(`Validation of ${rel} failed – please fix:\n${report.lines().join("\n")}\n`);
  process.exit(2);
}
if (report.warnings.length) {
  // Return warnings as context without blocking
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: "Validation OK, notes:\n" + report.warnings.join("\n"),
    },
  }));
}
