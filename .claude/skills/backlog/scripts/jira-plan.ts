/**
 * Prints the MCP calls that bring Jira in line with the local mirror, as JSON.
 *
 * The agent executes them with mcp-atlassian (jira_create_issue, jira_update_issue, jira_get_transitions,
 * jira_transition_issue, jira_create_issue_link), then records the returned keys with jira-record.ts.
 *
 * Usage: node jira-plan.ts [ST-NNN ...]
 */
import { loadBacklogConfig } from "../../../lib/config.ts";
import { jiraPlan } from "../../../lib/backlog-jira.ts";

const ids = process.argv.slice(2).filter((arg) => /^ST-\d+$/i.test(arg));
const cfg = loadBacklogConfig();

if (cfg.provider !== "jira") {
  console.error(`Backlog provider is '${cfg.provider}', not 'jira' – change backlog.provider in .claude/project.json.`);
  process.exit(1);
}

try {
  console.log(JSON.stringify(jiraPlan(cfg, ids), null, 2));
  process.exit(0);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
