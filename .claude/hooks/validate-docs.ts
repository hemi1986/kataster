/**
 * PostToolUse hook: validates discovery artifacts right after every write.
 *
 * - docs/domain/events.yaml → schema + references; on success event-storming.md and BACKLOG.md are re-rendered
 * - docs/stories/*.md       → validation of the changed story (lenient on dependencies) and of its status change
 *                             since the last commit (engineering workflow); on success BACKLOG.md is re-rendered
 * Exit 2 + stderr = Claude gets the errors back and has to fix them.
 */
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import * as d from "../lib/discovery.ts";
import * as e from "../lib/engineering.ts";

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
