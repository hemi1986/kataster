/** Renders docs/domain/event-storming.md from docs/domain/events.yaml (only if the model is valid). */
import * as d from "../../../lib/discovery.ts";

const report = new d.Report();
const model = d.validateEvents(report);
if (!report.ok || model === null) {
  for (const line of report.lines()) console.log(line);
  console.log("Not rendered – fix the errors first.");
  process.exit(1);
}
console.log(`Written: ${d.rel(d.writeEventStormingMd(model))}`);
