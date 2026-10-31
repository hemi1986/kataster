/** Validates all stories in docs/stories/ (frontmatter, references, Gherkin, status). Exit 1 on errors. */
import * as d from "../../../lib/discovery.ts";

const report = new d.Report();
const stories = d.validateStories(report);
for (const line of report.lines()) console.log(line);
if (report.ok) {
  const byStatus = new Map<string, number>();
  for (const s of stories.values()) byStatus.set(s.meta.status, (byStatus.get(s.meta.status) ?? 0) + 1);
  const summary = [...byStatus].map(([st, n]) => `${st}: ${n}`).join(", ");
  console.log(`OK – ${stories.size} stories` + (summary ? ` (${summary})` : ""));
}
process.exit(report.ok ? 0 : 1);
