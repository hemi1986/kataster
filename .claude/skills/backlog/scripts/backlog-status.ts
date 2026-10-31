/**
 * Where does the backlog stand? Which stories are linked, which changed locally, which changed in the tracker?
 * Writes nothing. `--check` exits 1 when there is drift, so a CI job can use it.
 */
import { loadBacklogConfig } from "../../../lib/config.ts";
import { statusGithub } from "../../../lib/backlog-github.ts";
import { jiraStatus } from "../../../lib/backlog-jira.ts";

const cfg = loadBacklogConfig();
if (cfg.provider === "local") {
  console.log("Backlog: local – docs/stories/ is the backlog, nothing to sync.");
  process.exit(0);
}

let result: { lines: string[]; drift: boolean };
try {
  result = cfg.provider === "github" ? statusGithub(cfg) : jiraStatus(cfg);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
console.log(`Backlog: ${cfg.provider}${cfg.provider === "jira" ? ` (${cfg.jira.project || "project not configured"})` : ""}`);
for (const line of result.lines) console.log(`  ${line}`);
const drift = result.drift;
console.log(
  drift
    ? `\nDrift found – ${cfg.provider === "github" ? "run /backlog-sync pull or push" : "run the MCP pull/push"}.`
    : cfg.provider === "jira"
      ? "\nThe local mirror is consistent with the last import – run the MCP pull to compare with Jira."
      : "\nEverything that is linked is in sync.",
);
process.exit(process.argv.includes("--check") && drift ? 1 : 0);
