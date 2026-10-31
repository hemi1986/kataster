/**
 * GitHub Issues adapter. Deterministic: every operation is a `gh` CLI call, so it works from a script, from a hook
 * (when asked to) and from the agent.
 *
 * The tracker is the source of truth. `pull` only overwrites a local story when the remote issue changed since the
 * last sync; if both sides changed, the tracker wins and the local file is backed up. `push` refuses a story whose
 * remote counterpart changed since the last sync – pull first, then decide.
 */
import { spawnSync } from "node:child_process";
import { isManagedLabel, labelPrefix, type BacklogConfig } from "./config.ts";
import * as d from "./discovery.ts";
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

type Json = Record<string, unknown>;

function gh(args: string[], input?: string): string {
  const r = spawnSync("gh", args, {
    cwd: d.ROOT,
    encoding: "utf8",
    input,
    timeout: 120_000,
  });
  if (r.error) throw new Error(`gh ${args[0]}: ${r.error.message}`);
  if (r.status !== 0) {
    const detail = `${r.stderr ?? ""}${r.stdout ?? ""}`.trim();
    throw new Error(`gh ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
  return (r.stdout ?? "").trim();
}

function repoArgs(cfg: BacklogConfig, repo = cfg.github.repo): string[] {
  return repo ? ["--repo", repo] : [];
}

function labelNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((label) => (typeof label === "string" ? label : label !== null && typeof label === "object" ? (label as Json).name : undefined))
    .filter((name): name is string => typeof name === "string" && name.length > 0);
}

function remoteIssues(cfg: BacklogConfig): RemoteIssue[] {
  const raw = gh([
    "issue", "list",
    "--state", "all",
    "--limit", "1000",
    "--json", "number,title,body,state,labels,url",
    ...repoArgs(cfg),
  ]);
  const parsed = JSON.parse(raw || "[]") as Json[];
  const prefix = labelPrefix(cfg);
  return parsed.map((issue) => ({
    key: String(issue.number),
    url: typeof issue.url === "string" ? issue.url : undefined,
    title: String(issue.title ?? ""),
    body: String(issue.body ?? ""),
    labels: labelNames(issue.labels),
    state: (String(issue.state).toLowerCase() === "closed" ? "closed" : "open") as "closed" | "open",
  })).filter((issue) => issue.labels.includes(prefix) || issue.body.includes("<!-- kataster:story") || issue.body.includes("```kataster-story"));
}

function remoteIssue(cfg: BacklogConfig, key: string, repo?: string): RemoteIssue | null {
  try {
    const issue = JSON.parse(gh([
      "issue", "view", key,
      "--json", "number,title,body,state,labels,url",
      ...repoArgs(cfg, repo),
    ])) as Json;
    return {
      key: String(issue.number),
      url: typeof issue.url === "string" ? issue.url : undefined,
      title: String(issue.title ?? ""),
      body: String(issue.body ?? ""),
      labels: labelNames(issue.labels),
      state: String(issue.state).toLowerCase() === "closed" ? "closed" : "open",
    };
  } catch (error) {
    const message = String(error);
    // A missing issue is an orphan; an auth or network failure is not and must reach the user.
    if (/not found|could not resolve|no issue/i.test(message)) return null;
    throw error;
  }
}

/**
 * Read-only lookup for `/feature` intake: the issue as evidence, without touching the mirror or the sync state.
 * `repo` overrides `backlog.github.repo` (a pasted URL may point at another repository).
 */
export function readGithubIssue(cfg: BacklogConfig, key: string, repo?: string): RemoteIssue | null {
  return remoteIssue(cfg, key, repo);
}

/** Creates labels that do not exist yet. Existing labels keep their colour and description. */
function ensureLabels(cfg: BacklogConfig, labels: string[]): void {
  if (!labels.length) return;
  const existing = new Set(
    (JSON.parse(gh(["label", "list", "--limit", "1000", "--json", "name", ...repoArgs(cfg)]) || "[]") as Json[])
      .map((label) => String(label.name)),
  );
  const prefix = labelPrefix(cfg);
  for (const label of labels) {
    if (existing.has(label)) continue;
    try {
      gh([
        "label", "create", label,
        "--color", isManagedLabel(label, prefix) ? "ededed" : "c5def5",
        "--description", isManagedLabel(label, prefix) ? "Managed by Kataster" : "Kataster story label",
        ...repoArgs(cfg),
      ]);
    } catch (error) {
      if (!/already exists/i.test(String(error))) throw error;
    }
  }
}

function shouldBeClosed(payloadStatus: string): boolean {
  return payloadStatus === "done" || payloadStatus === "superseded";
}

function closeReason(status: string): string {
  return status === "superseded" ? "not planned" : "completed";
}

function issueNumber(url: string): string {
  const match = /\/issues\/(\d+)\s*$/.exec(url.trim());
  if (!match) throw new Error(`could not read the issue number from '${url}'`);
  return match[1];
}

function setOpenState(cfg: BacklogConfig, key: string, wantClosed: boolean, status: string): void {
  const remote = remoteIssue(cfg, key);
  if (!remote) return;
  if (wantClosed && remote.state !== "closed") {
    gh(["issue", "close", key, "--reason", closeReason(status), ...repoArgs(cfg)]);
  } else if (!wantClosed && remote.state === "closed") {
    gh(["issue", "reopen", key, ...repoArgs(cfg)]);
  }
}

export interface SyncReport {
  lines: string[];
  changed: boolean;
}

/** Push local stories to GitHub. Stories without an external ref are created; existing ones are updated. */
export function pushGithub(cfg: BacklogConfig, ids: string[] = []): SyncReport {
  const wanted = new Set(ids.map((id) => id.toUpperCase()));
  const stories = d.loadStories().parsed.filter((story) => !wanted.size || wanted.has(d.storyId(story)));
  const state = readProviderState("github");
  const lines: string[] = [];
  let changed = false;

  for (const story of stories) {
    const id = d.storyId(story);
    if (!id) {
      lines.push(`skip      ${d.rel(story.path)}: no story id`);
      continue;
    }
    const payload = renderIssue(story, cfg);
    const ext = externalOf(story);
    if (ext && ext.provider !== "github") {
      lines.push(`skip      ${id}: linked to ${ext.provider} (${ext.key}) – change backlog.provider or remove the external ref`);
      continue;
    }

    if (!ext) {
      ensureLabels(cfg, payload.labels);
      const out = gh([
        "issue", "create",
        "--title", payload.title,
        "--body-file", "-",
        ...payload.labels.flatMap((label) => ["--label", label]),
        ...repoArgs(cfg),
      ], payload.body);
      const url = out.split("\n").map((line) => line.trim()).find((line) => /\/issues\/\d+$/.test(line)) ?? out.trim();
      const key = issueNumber(url);
      setExternal(story, { provider: "github", key, url });
      if (shouldBeClosed(payload.status)) setOpenState(cfg, key, true, payload.status);
      state.stories[id] = { key, url, localHash: storyHash(story), remoteHash: payloadHash(payload) };
      lines.push(`created   ${id} → #${key}`);
      changed = true;
      continue;
    }

    const entry = state.stories[id];
    const remote = remoteIssue(cfg, ext.key);
    if (!remote) {
      lines.push(`orphan    ${id}: GitHub issue #${ext.key} does not exist any more – nothing pushed`);
      continue;
    }
    const sentHash = payloadHash(payload);
    const currentRemoteHash = payloadHash(remotePayload(remote, cfg));
    const localChanged = entry ? storyHash(story) !== entry.localHash : true;
    const remoteChanged = entry ? currentRemoteHash !== entry.remoteHash : false;

    if (remoteChanged && !localChanged) {
      lines.push(`remote    ${id}: GitHub changed since the last sync – pull first, then push`);
      continue;
    }
    if (localChanged && remoteChanged) {
      lines.push(`conflict  ${id}: local and GitHub changed since the last sync – pull first, then push`);
      continue;
    }
    if (!localChanged && !remoteChanged) {
      lines.push(`unchanged ${id} (#${ext.key})`);
      continue;
    }

    ensureLabels(cfg, payload.labels);
    const add = payload.labels.filter((label) => !remote.labels.includes(label));
    const remove = remote.labels.filter((label) => !payload.labels.includes(label));

    gh([
      "issue", "edit", ext.key,
      "--title", payload.title,
      "--body-file", "-",
      ...add.flatMap((label) => ["--add-label", label]),
      ...remove.flatMap((label) => ["--remove-label", label]),
      ...repoArgs(cfg),
    ], payload.body);
    setOpenState(cfg, ext.key, shouldBeClosed(payload.status), payload.status);
    state.stories[id] = {
      key: ext.key,
      ...(ext.url ? { url: ext.url } : {}),
      localHash: storyHash(story),
      remoteHash: sentHash,
    };
    lines.push(`updated   ${id} → #${ext.key}`);
    changed = true;
  }

  state.provider = "github";
  if (changed) writeSyncState(state);
  if (changed) d.writeBacklogMd();
  if (!lines.length) lines.push("nothing to push – no stories in scope");
  return { lines, changed };
}

/** Pull GitHub issues into the local mirror. The tracker wins; local unpushed changes are reported. */
export function pullGithub(cfg: BacklogConfig): SyncReport {
  const issues = remoteIssues(cfg);
  const stories = d.loadStories().parsed;
  const byId = new Map(stories.map((story) => [d.storyId(story), story]));
  const byKey = new Map(
    stories.flatMap((story) => {
      const ext = externalOf(story);
      return ext && ext.provider === "github" ? [[ext.key, story] as const] : [];
    }),
  );
  const state = readProviderState("github");
  const contexts = knownContexts();
  const lines: string[] = [];
  let changed = false;
  let next = nextStoryId();

  for (const issue of issues) {
    const existingByKey = byKey.get(issue.key);
    const fallbackId = existingByKey ? d.storyId(existingByKey) : "";
    const parsed = parseIssue(issue, cfg, { contexts, fallbackId });
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
    if (existingExt && (existingExt.provider !== "github" || existingExt.key !== issue.key)) {
      lines.push(`conflict  ${id}: local story is linked to ${existingExt.provider} ${existingExt.key}, but #${issue.key} claims the same id – skipped`);
      continue;
    }

    const remoteHash = payloadHash(remotePayload(issue, cfg));
    const entry = state.stories[id];
    const localHash = existing ? storyHash(existing) : "";
    const remoteUnchanged = Boolean(entry && entry.remoteHash === remoteHash);
    const localChanged = Boolean(existing && entry && localHash !== entry.localHash);

    // Fresh clone: the mirror is committed, the sync state is not. If the local story already renders to the same
    // issue, only the state is missing – no conflict, no backup, no rewrite.
    if (existing && !entry && payloadHash(renderIssue(existing, cfg)) === remoteHash) {
      state.stories[id] = {
        key: issue.key,
        ...(issue.url ? { url: issue.url } : {}),
        localHash,
        remoteHash,
      };
      lines.push(`synced    ${id} ← #${issue.key} (state rebuilt)`);
      continue;
    }

    // No remote change: a local story that is ahead stays as it is.
    if (existing && remoteUnchanged && localChanged) {
      lines.push(`local     ${id}: local changes are not pushed yet – GitHub did not change, left alone`);
      continue;
    }

    if (existing && entry && localChanged && !remoteUnchanged) {
      const backup = backupStory(existing);
      lines.push(`conflict  ${id}: local and GitHub changed – the tracker wins, local copy saved to ${backup}`);
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
    lines.push(`${existing ? "updated " : "imported"}  ${id} ← #${issue.key} (${d.rel(path)})`);
    changed = true;
  }

  const remoteKeys = new Set(issues.map((issue) => issue.key));
  for (const story of stories) {
    const ext = externalOf(story);
    if (!ext) continue;
    if (ext.provider !== "github") continue;
    if (!remoteKeys.has(ext.key)) lines.push(`orphan    ${d.storyId(story)}: linked to #${ext.key}, which is no longer in the issue list`);
  }
  for (const story of stories) {
    if (!externalOf(story)) lines.push(`local     ${d.storyId(story)}: not linked to GitHub yet – push to create the issue`);
  }

  state.provider = "github";
  if (changed) writeSyncState(state);
  if (changed) d.writeBacklogMd();
  if (!lines.length) lines.push("nothing to pull – no Kataster issues found");
  return { lines, changed };
}

/** Compares the local mirror with GitHub without writing anything. */
export function statusGithub(cfg: BacklogConfig): { lines: string[]; drift: boolean } {
  const issues = remoteIssues(cfg);
  const remoteByKey = new Map(issues.map((issue) => [issue.key, issue]));
  const state = readProviderState("github");
  const lines: string[] = [];
  let drift = false;

  for (const story of d.loadStories().parsed) {
    const id = d.storyId(story);
    const ext = externalOf(story);
    if (!ext || ext.provider !== "github") {
      const committed = ["ready", "in-progress", "done"].includes(String(story.meta.status));
      lines.push(`${committed ? "missing" : "local  "}    ${id}: ${committed ? "must be linked to GitHub" : "not linked to GitHub"}`);
      if (committed) drift = true;
      continue;
    }
    const remote = remoteByKey.get(ext.key);
    if (!remote) {
      lines.push(`orphan     ${id}: #${ext.key} is not in the issue list`);
      drift = true;
      continue;
    }
    const entry = state.stories[id];
    if (!entry) {
      lines.push(`unknown    ${id}: #${ext.key} has no sync state yet – pull or push once`);
      drift = true;
      continue;
    }
    const localChanged = storyHash(story) !== entry.localHash;
    const remoteChanged = payloadHash(remotePayload(remote, cfg)) !== entry.remoteHash;
    if (localChanged && remoteChanged) {
      lines.push(`conflict   ${id}: local and GitHub changed since the last sync`);
      drift = true;
    } else if (localChanged) {
      lines.push(`local      ${id}: local changes are not pushed`);
      drift = true;
    } else if (remoteChanged) {
      lines.push(`remote     ${id}: GitHub changed – pull to update the mirror`);
      drift = true;
    } else {
      lines.push(`synced     ${id} ↔ #${ext.key}`);
    }
  }

  const localKeys = new Set(
    d.loadStories().parsed.flatMap((story) => {
      const ext = externalOf(story);
      return ext && ext.provider === "github" ? [ext.key] : [];
    }),
  );
  for (const issue of issues) {
    if (!localKeys.has(issue.key)) {
      lines.push(`remote     #${issue.key}: Kataster issue without a local story`);
      drift = true;
    }
  }
  return { lines, drift };
}

/** Sets the status of a linked GitHub issue (title/body/labels + open/closed) after a local status change. */
export function githubSetStatus(story: d.Story, status: string, cfg: BacklogConfig): string {
  const ext = externalOf(story);
  if (!ext) return "GitHub: story is not linked yet – run /backlog-sync push.";
  if (ext.provider !== "github") return `GitHub: story is linked to ${ext.provider} (${ext.key}), not to GitHub – nothing changed.`;
  const remote = remoteIssue(cfg, ext.key);
  if (!remote) return `GitHub: #${ext.key} does not exist any more – nothing changed.`;

  const entry = readProviderState("github").stories[d.storyId(story)];
  if (entry && payloadHash(remotePayload(remote, cfg)) !== entry.remoteHash) {
    return `GitHub: #${ext.key} changed since the last sync – pull first, then set the status again.`;
  }

  const updated = { ...story, meta: { ...story.meta, status } };
  const payload = renderIssue(updated, cfg);
  ensureLabels(cfg, payload.labels);
  const add = payload.labels.filter((label) => !remote.labels.includes(label));
  const remove = remote.labels.filter((label) => !payload.labels.includes(label));

  gh([
    "issue", "edit", ext.key,
    "--title", payload.title,
    "--body-file", "-",
    ...add.flatMap((label) => ["--add-label", label]),
    ...remove.flatMap((label) => ["--remove-label", label]),
    ...repoArgs(cfg),
  ], payload.body);
  setOpenState(cfg, ext.key, shouldBeClosed(status), status);

  const state = readProviderState("github");
  state.provider = "github";
  state.stories[d.storyId(story)] = {
    key: ext.key,
    ...(ext.url ? { url: ext.url } : {}),
    localHash: storyHash(story),
    remoteHash: payloadHash(payload),
  };
  writeSyncState(state);
  return `GitHub: #${ext.key} → ${status}.`;
}

