/**
 * One place for "the local story status changed – what does that mean for the tracker?".
 *
 * GitHub can be updated deterministically from here (a `gh` call). Jira cannot: the MCP server is only reachable
 * from the agent, so the best a script can do is print the exact transition the agent has to perform. Neither
 * failure may block the local workflow – the mirror stays usable, and the next sync reports the drift.
 */
import * as d from "./discovery.ts";
import { labelPrefix, loadBacklogConfig } from "./config.ts";
import { externalOf } from "./backlog.ts";
import { githubSetStatus } from "./backlog-github.ts";

export function syncStatusAfterChange(story: d.Story, status: string): string | null {
  const cfg = loadBacklogConfig();
  if (cfg.provider === "local") return null;
  if (process.argv.includes("--no-tracker")) return null;

  const ext = externalOf(story);
  if (!ext) {
    return `Backlog: ${cfg.provider} – ${d.storyId(story)} is not linked yet; run /backlog-sync push.`;
  }
  if (ext.provider !== cfg.provider) {
    return `Backlog: ${d.storyId(story)} is linked to ${ext.provider} (${ext.key}), but the provider is ${cfg.provider} – fix .claude/project.json or the external ref.`;
  }
  if (cfg.provider === "jira") {
    const target = cfg.jira.statusMap[status] ?? status;
    return (
      `Backlog: Jira ${ext.key} was not changed from here (MCP is agent-only). ` +
      `Transition it to '${target}' with jira_get_transitions + jira_transition_issue, then /backlog-sync push.`
    );
  }
  try {
    return githubSetStatus(story, status, cfg);
  } catch (error) {
    return `Backlog: GitHub #${ext.key} could not be updated (${error instanceof Error ? error.message : String(error)}); run /backlog-sync push.`;
  }
}

/** Label prefix of the active provider – used by the session start hint. */
export function activeLabelPrefix(): string {
  return labelPrefix(loadBacklogConfig());
}
