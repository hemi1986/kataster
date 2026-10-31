/** Validates docs/domain/events.yaml (schema + references). Exit 1 on errors. */
import * as d from "../../../lib/discovery.ts";

const report = new d.Report();
const model = d.validateEvents(report);
for (const line of report.lines()) console.log(line);
if (report.ok && model !== null) {
  const counts = d.LIST_KEYS.map((k) => [k, Array.isArray(model[k]) ? model[k].length : 0] as const).filter(([, n]) => n);
  console.log("OK – " + counts.map(([k, n]) => `${k}: ${n}`).join(", "));
}
process.exit(report.ok ? 0 : 1);
