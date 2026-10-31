/**
 * Imports Jira issue data into the local mirror.
 *
 * The agent fetches the issues with mcp-atlassian (jira_search / jira_get_issue) and writes them as JSON. Accepted
 * shapes:
 *
 *   [{ "key": "PROJ-123", "summary": "ST-012: …", "description": "…", "status": "Ready",
 *      "labels": ["kataster", "kataster-status-ready"], "priority": "High", "browse_url": "…" }]
 *
 *   [{ "key": "PROJ-123", "fields": { "summary": "…", "description": "…", "status": { "name": "Ready" },
 *      "priority": { "name": "High" }, "labels": ["…"] } }]
 *
 * Usage: node jira-import.ts --from <issues.json>
 */
import { readFileSync } from "node:fs";
import { loadBacklogConfig } from "../../../lib/config.ts";
import { jiraImport } from "../../../lib/backlog-jira.ts";

const cfg = loadBacklogConfig();
const fromIndex = process.argv.indexOf("--from");
const from = fromIndex >= 0 ? process.argv[fromIndex + 1] : "";
if (!from) {
  console.error("Usage: node jira-import.ts --from <issues.json>");
  process.exit(1);
}
if (cfg.provider !== "jira") {
  console.error(`Backlog provider is '${cfg.provider}', not 'jira'.`);
  process.exit(1);
}

try {
  const raw = JSON.parse(readFileSync(from, "utf8"));
  const issues = Array.isArray(raw) ? raw : raw.issues ?? raw.values ?? raw.results ?? [];
  const report = jiraImport(cfg, issues);
  for (const line of report.lines) console.log(line);
  process.exit(0);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
