/** Regenerates docs/stories/BACKLOG.md from the story files (also after deleting or renaming stories). */
import * as d from "../../../lib/discovery.ts";

console.log(`Written: ${d.rel(d.writeBacklogMd())}`);
