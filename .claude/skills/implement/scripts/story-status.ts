/**
 * Moves a story to a new status, enforcing the workflow and its preconditions:
 *   in-progress / done – all depends_on are done
 *   done (story)       – every Gherkin scenario has a test titled `ST-NNN: <scenario title>`
 *   done (all types)   – every checklist item in the acceptance criteria is ticked (`- [x]`) – also a story's foundation checklist
 *   done is final      – changes become a new story
 *   superseded         – from draft, review or ready: done elsewhere or replaced by a new planning; final as well
 *
 * Usage: node story-status.ts ST-010 in-progress|ready|done|review|superseded
 */
import * as d from "../../../lib/discovery.ts";
import * as e from "../../../lib/engineering.ts";
import { syncStatusAfterChange } from "../../../lib/backlog-sync.ts";

const [id, to] = process.argv.slice(2);
if (!id || !to || !(d.STATUSES as readonly string[]).includes(to)) {
  console.error(`Usage: node story-status.ts ST-NNN <${d.STATUSES.join("|")}>`);
  process.exit(1);
}
const stories = e.storiesById();
const story = stories.get(id.toUpperCase());
if (!story) {
  console.error(`Story '${id}' not found in docs/stories/.`);
  process.exit(1);
}
const from = String(story.meta.status);
const errs = e.transitionErrors(story, from, to, stories);
if (errs.length) {
  console.error(`${d.storyId(story)} cannot go from '${from}' to '${to}':\n${errs.map((x) => `  - ${x}`).join("\n")}`);
  process.exit(1);
}
e.writeStatus(story, to);

const report = new d.Report();
d.validateStories(report, story.path, true);
if (!report.ok) {
  e.writeStatus(story, from);
  console.error(`Validation failed, status left at '${from}':\n${report.lines().join("\n")}`);
  process.exit(1);
}
d.writeBacklogMd();
console.log(`${d.storyId(story)}: ${from} → ${to}`);

// With a tracker the local mirror is only half the change. GitHub can follow from here (gh); for Jira this prints
// the MCP transition the agent has to run. A failure here never rolls the status back.
const tracker = syncStatusAfterChange({ ...story, meta: { ...story.meta, status: to } }, to);
if (tracker) console.log(tracker);
