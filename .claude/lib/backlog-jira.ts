/**
 * Jira adapter.
 *
 * Jira is reached through the `mcp-atlassian` MCP server, which only the agent can call – a plain Node script cannot
 * speak MCP. This module therefore does the deterministic half:
 *
 *   - `jiraPlan` turns the local stories into exact MCP calls (`jira_create_issue`, `jira_update_issue`,
 *     `jira_transition_issue`, `jira_create_issue_link`)
 *   - `jiraRecord` writes the issue keys the agent got back into the story frontmatter
 *   - `jiraImport` rebuilds the local mirror from the issue data the agent fetched with `jira_search`/`jira_get_issue`
 *
 * The skill `backlog` owns the order of those steps. Nothing here talks to the network.
 */
import * as d from "./discovery.ts";
import type { BacklogConfig } from "./config.ts";
import {
  backupStory,
  bumpStoryId,
  externalOf,
  knownContexts,
  nextStoryId,
  parseIssue,
  payloadHash,
  readProviderState,
  remotePayload,
  renderIssue,
  setExternal,
  storyHash,
  writeStory,
  writeSyncState,
  type RemoteIssue,
} from "./backlog.ts";

export interface JiraAction {
  story: string;
  action: "create" | "update" | "transition" | "link" | "skip";
  tool: string;
  arguments: Record<string, unknown>;
  note?: string;
}

export interface JiraPlan {
  provider: "jira";
  project: string;
  issueType: string;
  mcpServer: string;
  actions: JiraAction[];
}

const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

function additionalFields(payload: { labels: string[] }, priority: unknown, cfg: BacklogConfig): string {
  const fields: Record<string, unknown> = { labels: payload.labels };
  const priorityName = cfg.jira.priorityMap[String(priority)] ?? undefined;
  if (priorityName) fields.priority = { name: priorityName };
  return JSON.stringify(fields);
}

/** The exact MCP calls that bring Jira in line with the local mirror (one direction: local → Jira). */
export function jiraPlan(cfg: BacklogConfig, ids: string[] = []): JiraPlan {
  if (!cfg.jira.project) throw new Error("backlog.jira.project is empty in .claude/project.json");
  const wanted = new Set(ids.map((id) => id.toUpperCase()));
  const allStories = d.loadStories().parsed;
  const stories = allStories.filter((story) => !wanted.size || wanted.has(d.storyId(story)));
  const byId = new Map(allStories.map((story) => [d.storyId(story), story]));
  const actions: JiraAction[] = [];

  for (const story of stories) {
    const id = d.storyId(story);
    const payload = renderIssue(story, cfg);
    const ext = externalOf(story);
    if (ext && ext.provider !== "jira") {
      actions.push({
        story: id,
        action: "skip",
        tool: "",
        arguments: {},
        note: `Linked to ${ext.provider} (${ext.key}); change backlog.provider or remove the external ref.`,
      });
      continue;
    }
    const target = cfg.jira.statusMap[String(story.meta.status)] ?? String(story.meta.status);
    const priority = story.meta.priority;

    if (!ext) {
      actions.push({
        story: id,
        action: "create",
        tool: "jira_create_issue",
        arguments: {
          project_key: cfg.jira.project,
          issue_type: cfg.jira.issueType,
          summary: payload.title,
          description: payload.body,
          additional_fields: additionalFields(payload, priority, cfg),
        },
        note: `Record the returned key with jira-record.ts, then run jira-plan.ts again for the transition to '${target}' and the links.`,
      });
    } else {
      actions.push({
        story: id,
        action: "update",
        tool: "jira_update_issue",
        arguments: {
          issue_key: ext.key,
          fields: JSON.stringify({ summary: payload.title, description: payload.body }),
          additional_fields: additionalFields(payload, priority, cfg),
          return_fields: "summary,status,labels,priority",
        },
      });
      actions.push({
        story: id,
        action: "transition",
        tool: "jira_transition_issue",
        arguments: { issue_key: ext.key, transition_id: target },
        note: `Run jira_get_transitions first; use the transition that reaches '${target}'. Skip if Jira is already there.`,
      });
    }

    for (const dep of list(story.meta.depends_on)) {
      const dependency = byId.get(dep);
      const depExt = dependency ? externalOf(dependency) : null;
      if (!ext) {
        actions.push({
          story: id,
          action: "skip",
          tool: "",
          arguments: {},
          note: `Depends on ${dep}; create ${id} first, then run jira-plan.ts again for the link.`,
        });
        continue;
      }
      if (!depExt) {
        actions.push({
          story: id,
          action: "skip",
          tool: "",
          arguments: {},
          note: `Depends on ${dep}, which has no Jira key yet; create/link ${dep} first, then run jira-plan.ts again.`,
        });
        continue;
      }
      actions.push({
        story: id,
        action: "link",
        tool: "jira_create_issue_link",
        arguments: {
          link_type: "Blocks",
          outward_issue_key: depExt.key,
          inward_issue_key: ext.key,
        },
        note: `${depExt.key} (${dep}) blocks ${ext.key} (${id}).`,
      });
    }
  }

  return {
    provider: "jira",
    project: cfg.jira.project,
    issueType: cfg.jira.issueType,
    mcpServer: cfg.jira.mcpServer,
    actions,
  };
}

export interface JiraRecord {
  story: string;
  key: string;
  url?: string;
}

/** Writes the keys the agent got back from `jira_create_issue` into the story files. */
export function jiraRecord(cfg: BacklogConfig, results: JiraRecord[]): string[] {
  const stories = new Map(d.loadStories().parsed.map((story) => [d.storyId(story), story]));
  const state = readProviderState("jira");
  const lines: string[] = [];
  for (const result of results) {
    const story = stories.get(result.story.toUpperCase());
    if (!story) {
      lines.push(`skip      ${result.story}: no such story`);
      continue;
    }
    if (!result.key) {
      lines.push(`skip      ${result.story}: no Jira key`);
      continue;
    }
    setExternal(story, { provider: "jira", key: result.key, ...(result.url ? { url: result.url } : {}) });
    state.stories[d.storyId(story)] = {
      key: result.key,
      ...(result.url ? { url: result.url } : {}),
      localHash: storyHash(story),
      remoteHash: "",
    };
    lines.push(`linked    ${d.storyId(story)} → ${result.key}`);
  }
  state.provider = "jira";
  if (lines.some((line) => line.startsWith("linked"))) writeSyncState(state);
  return lines;
}

/** Accepts the shapes `jira_search` / `jira_get_issue` return, or the normalized shape the skill documents. */
export function normalizeJiraIssue(raw: d.Obj): RemoteIssue | null {
  const fields = (raw.fields ?? raw) as d.Obj;
  const key = raw.key ?? raw.issue_key ?? raw.issueKey;
  if (typeof key !== "string" || !key) return null;
  const status = typeof fields.status === "string" ? fields.status : fields.status?.name;
  const priority = typeof fields.priority === "string" ? fields.priority : fields.priority?.name;
  const labels = list(fields.labels ?? raw.labels);
  const description = fields.description ?? raw.description ?? "";
  return {
    key,
    url: typeof raw.browse_url === "string" ? raw.browse_url : typeof raw.url === "string" ? raw.url : undefined,
    title: String(fields.summary ?? raw.summary ?? ""),
    body: typeof description === "string" ? description : "",
    labels,
    status: typeof status === "string" ? status : undefined,
    priority: typeof priority === "string" ? priority : undefined,
  };
}

/** Rebuilds local stories from Jira issue data. The tracker wins; unpushed local changes are reported. */
export function jiraImport(cfg: BacklogConfig, rawIssues: d.Obj[]): { lines: string[]; changed: boolean } {
  const issues = rawIssues.map(normalizeJiraIssue).filter((issue): issue is RemoteIssue => issue !== null);
  const stories = d.loadStories().parsed;
  const byId = new Map(stories.map((story) => [d.storyId(story), story]));
  const byKey = new Map(
    stories.flatMap((story) => {
      const ext = externalOf(story);
      return ext && ext.provider === "jira" ? [[ext.key, story] as const] : [];
    }),
  );
  const state = readProviderState("jira");
  const contexts = knownContexts();
  const lines: string[] = [];
  let changed = false;
  let next = nextStoryId();

  for (const issue of issues) {
    const existingByKey = byKey.get(issue.key);
    const parsed = parseIssue(issue, cfg, {
      contexts,
      fallbackId: existingByKey ? d.storyId(existingByKey) : "",
    });
    // The story id is stable; an issue matched by its external key keeps the id it already has.
    let id = existingByKey ? d.storyId(existingByKey) : parsed.id;
    if (existingByKey && parsed.id && parsed.id !== id) {
      lines.push(`warning   ${id}: the issue title claims ${parsed.id}; the stable id stays ${id}`);
    }
    if (!id) {
      id = next;
      next = bumpStoryId(next);
    }
    const existing = byId.get(id) ?? existingByKey;
    const existingExt = existing ? externalOf(existing) : null;
    if (existingExt && (existingExt.provider !== "jira" || existingExt.key !== issue.key)) {
      lines.push(`conflict  ${id}: local story is linked to ${existingExt.provider} ${existingExt.key}, but ${issue.key} claims the same id – skipped`);
      continue;
    }
    if (!parsed.meta.context) {
      lines.push(`warning   ${issue.key} (${id}): no bounded context in the issue – fix it in Jira or the mirror will fail validation`);
    }

    const remoteHash = payloadHash(remotePayload(issue, cfg));
    const entry = state.stories[id];
    const localHash = existing ? storyHash(existing) : "";
    const remoteUnchanged = Boolean(entry && entry.remoteHash === remoteHash);
    const localChanged = Boolean(existing && entry && localHash !== entry.localHash);

    // Fresh clone: the state is not committed, the mirror is. Rebuild the state without touching the story.
    if (existing && !entry && payloadHash(renderIssue(existing, cfg)) === remoteHash) {
      state.stories[id] = {
        key: issue.key,
        ...(issue.url ? { url: issue.url } : {}),
        localHash,
        remoteHash,
      };
      lines.push(`synced    ${id} ← ${issue.key} (state rebuilt)`);
      continue;
    }

    if (existing && remoteUnchanged && localChanged) {
      lines.push(`local     ${id}: local changes are not pushed yet – Jira did not change, left alone`);
      continue;
    }
    if (existing && entry && localChanged && !remoteUnchanged) {
      const backup = backupStory(existing);
      lines.push(`conflict  ${id}: local and Jira changed – the tracker wins, local copy saved to ${backup}`);
    } else if (existing && !entry) {
      const backup = backupStory(existing);
      lines.push(`conflict  ${id}: no sync state yet – the tracker wins, local copy saved to ${backup}`);
    }

    const path = writeStory(id, parsed.meta, parsed.body, existing);
    state.stories[id] = {
      key: issue.key,
      ...(issue.url ? { url: issue.url } : {}),
      localHash: storyHash({ ...parsed, path } as d.Story),
      remoteHash,
    };
    lines.push(`${existing ? "updated " : "imported"}  ${id} ← ${issue.key} (${d.rel(path)})`);
    changed = true;
  }

  const importedKeys = new Set(issues.map((issue) => issue.key));
  for (const story of stories) {
    const ext = externalOf(story);
    if (!ext || ext.provider !== "jira") continue;
    if (!importedKeys.has(ext.key)) lines.push(`orphan    ${d.storyId(story)}: linked to ${ext.key}, which was not in the import`);
  }
  for (const story of stories) {
    if (!externalOf(story)) lines.push(`local     ${d.storyId(story)}: not linked to Jira yet – run jira-plan and record the key`);
  }

  state.provider = "jira";
  if (changed) writeSyncState(state);
  if (changed) d.writeBacklogMd();
  if (!lines.length) lines.push("nothing to import");
  return { lines, changed };
}

/** What can be said about the Jira side without calling MCP: which stories are linked, and which are local only. */
export function jiraStatus(cfg: BacklogConfig): { lines: string[]; drift: boolean } {
  const state = readProviderState("jira");
  const lines: string[] = [];
  let drift = false;
  for (const story of d.loadStories().parsed) {
    const id = d.storyId(story);
    const ext = externalOf(story);
    if (!ext || ext.provider !== "jira") {
      const committed = ["ready", "in-progress", "done"].includes(String(story.meta.status));
      lines.push(`${committed ? "missing" : "local  "}    ${id}: ${committed ? "must be linked to Jira" : "not linked to Jira"}`);
      if (committed) drift = true;
      continue;
    }
    const entry = state.stories[id];
    if (!entry) {
      lines.push(`unknown    ${id}: linked to ${ext.key}, but no sync state yet – run jira-import once`);
      drift = true;
    } else if (storyHash(story) !== entry.localHash) {
      lines.push(`local      ${id}: local changes are not pushed to ${ext.key}`);
      drift = true;
    } else {
      lines.push(`linked     ${id} ↔ ${ext.key} (Jira status not checked – use the MCP pull)`);
    }
  }
  return { lines, drift };
}
