/**
 * Prints the story to work on: a story already in progress, otherwise the first `ready` story
 * in backlog order whose dependencies are all done.
 *
 * Usage: node next-story.ts [--json]
 */
import * as d from "../../../lib/discovery.ts";
import * as e from "../../../lib/engineering.ts";

const { inProgress, next, blocked } = e.nextStory();
const brief = (s: d.Story) => ({ id: d.storyId(s), title: s.meta.title, type: s.meta.type, size: s.meta.size, path: d.rel(s.path) });

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ inProgress: inProgress.map(brief), next: next && brief(next), blocked: blocked.length }, null, 2));
  process.exit(0);
}
for (const s of inProgress) console.log(`IN PROGRESS  ${d.storyId(s)} – ${s.meta.title} (${d.rel(s.path)}) – finish this first`);
if (next) {
  console.log(`NEXT         ${d.storyId(next)} – ${next.meta.title} [${next.meta.type}, ${next.meta.size}] (${d.rel(next.path)})`);
} else {
  console.log("NEXT         none – no ready story has all its dependencies done");
}
console.log(`${blocked.length} ready stories are waiting for dependencies.`);
