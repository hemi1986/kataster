/**
 * Traceability between the event storming model and the code.
 * Commands, events, read models etc. are referenced in the code by their ID from docs/domain/events.yaml
 * (e.g. a command is registered as "CMD-ReportProblem", a journal entry has type "EVT-ProblemReported").
 *
 *   ERROR  an ID in the code that does not exist in events.yaml (renamed or invented)
 *   INFO   which commands and read models are implemented
 *
 * Usage: node check-commands.ts [--verbose]
 */
import * as d from "../../../lib/discovery.ts";
import * as e from "../../../lib/engineering.ts";

const model = d.loadEventsModel();
if (model === null) {
  console.error("docs/domain/events.yaml is missing or invalid.");
  process.exit(1);
}
const idx = d.indexModel(model);
const used = e.domainIdsInCode();
const report = new d.Report();
for (const [id, files] of used) {
  if (!idx.has(id)) report.error(files.join(", "), `'${id}' does not exist in docs/domain/events.yaml`);
}

const coverage = (key: string): string => {
  const all = (model[key] ?? []) as d.Obj[];
  const done = all.filter((x) => used.has(x.id));
  return `${done.length}/${all.length} ${key.replace("_", " ")} in code`;
};
console.log(`INFO     ${coverage("commands")} · ${coverage("read_models")} · ${coverage("policies")}`);
if (process.argv.includes("--verbose")) {
  for (const c of (model.commands ?? []) as d.Obj[]) console.log(`INFO     ${used.has(c.id) ? "✓" : " "} ${c.id}`);
}
for (const line of report.lines()) console.log(line);
console.log(report.ok ? "Domain ID traceability OK." : `${report.errors.length} error(s).`);
process.exit(report.ok ? 0 : 1);
