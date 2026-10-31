/**
 * Pulls tracker changes into the local mirror.
 *
 *   GitHub  deterministic, via `gh`
 *   Jira    requires the issue data the agent fetched through MCP: `--from <issues.json>`
 *
 * Usage: node backlog-pull.ts [--from <jira-issues.json>]
 */
import { readFileSync } from "node:fs";
import { loadBacklogConfig } from "../../../lib/config.ts";
import { pullGithub } from "../../../lib/backlog-github.ts";
import { jiraImport } from "../../../lib/backlog-jira.ts";

const cfg = loadBacklogConfig();
const fromIndex = process.argv.indexOf("--from");
const from = fromIndex >= 0 ? process.argv[fromIndex + 1] : "";

if (cfg.provider === "local") {
  console.log("Backlog: local – docs/stories/ is the backlog, nothing to pull.");
  process.exit(0);
}
if (cfg.provider === "jira" && !from) {
  console.error(
    "Backlog: jira is reached through mcp-atlassian, which only the agent can call.\n" +
      "  Fetch the issues with jira_search/jira_get_issue, write them as JSON, then:\n" +
      "  node .claude/skills/backlog/scripts/backlog-pull.ts --from <issues.json>",
  );
  process.exit(2);
}

try {
  if (cfg.provider === "github") {
    const report = pullGithub(cfg);
    for (const line of report.lines) console.log(line);
  } else {
    const raw = JSON.parse(readFileSync(from, "utf8"));
    const issues = Array.isArray(raw) ? raw : raw.issues ?? raw.values ?? raw.results ?? [];
    const report = jiraImport(cfg, issues);
    for (const line of report.lines) console.log(line);
  }
  process.exit(0);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
