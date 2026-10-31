/**
 * Records the Jira keys the agent got back from jira_create_issue.
 *
 * Input (one array for all stories):
 *   [{ "story": "ST-012", "key": "PROJ-123", "url": "https://…/browse/PROJ-123" }]
 *
 * Usage: node jira-record.ts --from <results.json>
 */
import { readFileSync } from "node:fs";
import { loadBacklogConfig } from "../../../lib/config.ts";
import { jiraRecord, type JiraRecord } from "../../../lib/backlog-jira.ts";

const cfg = loadBacklogConfig();
const fromIndex = process.argv.indexOf("--from");
const from = fromIndex >= 0 ? process.argv[fromIndex + 1] : "";
if (!from) {
  console.error("Usage: node jira-record.ts --from <results.json>");
  process.exit(1);
}
if (cfg.provider !== "jira") {
  console.error(`Backlog provider is '${cfg.provider}', not 'jira'.`);
  process.exit(1);
}

try {
  const raw = JSON.parse(readFileSync(from, "utf8"));
  const rows = Array.isArray(raw) ? raw : raw.results ?? raw.issues ?? [];
  const results: JiraRecord[] = rows
    .map((row: Record<string, unknown>) => ({
      story: String(row.story ?? row.id ?? ""),
      key: String(row.key ?? row.issue_key ?? row.issueKey ?? ""),
      url: typeof row.url === "string" ? row.url : typeof row.browse_url === "string" ? row.browse_url : undefined,
    }))
    .filter((row: JiraRecord) => row.story && row.key);
  const lines = jiraRecord(cfg, results);
  for (const line of lines) console.log(line);
  process.exit(lines.some((line) => line.startsWith("skip")) ? 1 : 0);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
