/**
 * Publishes local stories to the tracker.
 *
 *   GitHub  deterministic, via `gh`
 *   Jira    cannot be done from a script – MCP is agent-only. This prints the exact next step and exits 2.
 *
 * Usage: node backlog-push.ts [ST-NNN ...]
 */
import { loadBacklogConfig } from "../../../lib/config.ts";
import { pushGithub } from "../../../lib/backlog-github.ts";

const ids = process.argv.slice(2).filter((arg) => /^ST-\d+$/i.test(arg));
const cfg = loadBacklogConfig();

if (cfg.provider === "local") {
  console.log("Backlog: local – the story files are the backlog, nothing to push.");
  process.exit(0);
}
if (cfg.provider === "jira") {
  const scope = ids.length ? ` ${ids.join(" ")}` : "";
  console.error(
    "Backlog: jira is reached through mcp-atlassian, which only the agent can call.\n" +
      `  1. node .claude/skills/backlog/scripts/jira-plan.ts${scope}\n` +
      "  2. Execute every action with the mcp-atlassian tools.\n" +
      "  3. node .claude/skills/backlog/scripts/jira-record.ts --from <results.json>\n" +
      "  4. Run jira-plan.ts again to create the issue links.",
  );
  process.exit(2);
}

try {
  const report = pushGithub(cfg, ids);
  for (const line of report.lines) console.log(line);
  process.exit(0);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
