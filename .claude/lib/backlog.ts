/**
 * The backlog provider contract and its local representation.
 *
 * The story file is always the same Markdown document: YAML frontmatter plus the domain body. In `local` mode those
 * files *are* the backlog. With `github` or `jira`, the tracker is the source of truth and `docs/stories/` is the
 * local mirror:
 *
 *   - a story keeps its stable `ST-NNN` id (tests are titled `ST-NNN: <scenario>`) and gets
 *     `external: { provider, key, url }`
 *   - the issue body carries the story body plus a machine-readable `<!-- kataster:story … -->` block, so a pull can
 *     restore every field even where the tracker has no field for it
 *   - facets the tracker *does* have (status, priority, type, context, size, risk) also become managed labels (and,
 *     for Jira, the priority field); on a pull they win over the machine block
 *
 * This module is deterministic and does no network I/O. `backlog-github.ts` talks to `gh`, `backlog-jira.ts`
 * prepares and consumes the MCP payloads, and the skills own the Jira tool calls.
 */
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import * as d from "./discovery.ts";
import { isManagedLabel, labelPrefix, type BacklogConfig } from "./config.ts";

// --------------------------------------------------------------------------
// Types
// --------------------------------------------------------------------------
export interface ExternalRef {
  provider: "github" | "jira";
  key: string;
  url?: string;
}

export interface IssuePayload {
  title: string;
  body: string;
  labels: string[];
  status: string;
}

export interface RemoteIssue {
  key: string;
  url?: string;
  title: string;
  body: string;
  labels: string[];
  /** GitHub: open/closed. Jira leaves this undefined. */
  state?: "open" | "closed";
  /** Jira: the tracker status name (e.g. "In Progress"). */
  status?: string;
  /** Jira: the tracker priority name (e.g. "High"). */
  priority?: string;
}

/** Jira labels allow only letters, numbers and a few separators. */
const sanitizeJiraLabel = (label: string): string => label.replace(/[^A-Za-z0-9_.-]/g, "-");

const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const META_RE =
  /(?:<!--\s*kataster:story\s*\r?\n([\s\S]*?)\r?\n\s*-->|```kataster-story[ \t]*\r?\n([\s\S]*?)\r?\n```)/;
const ID_PREFIX_RE = /^(ST-\d{3,})\s*:\s*/;

// --------------------------------------------------------------------------
// External reference in the story frontmatter
// --------------------------------------------------------------------------
export function externalOf(story: d.Story): ExternalRef | null {
  const ext = story.meta.external;
  if (!ext || typeof ext !== "object") return null;
  if (typeof ext.key !== "string" || !ext.key) return null;
  if (ext.provider !== "github" && ext.provider !== "jira") return null;
  return { provider: ext.provider, key: ext.key, url: typeof ext.url === "string" && ext.url ? ext.url : undefined };
}

/** Writes (or replaces) the `external:` block without re-formatting the rest of the frontmatter. */
export function setExternal(story: d.Story, external: ExternalRef): void {
  const text = readFileSync(story.path, "utf8");
  const end = text.indexOf("\n---", 4);
  if (end === -1) throw new Error(`${d.rel(story.path)}: frontmatter is not closed with '---'`);
  let front = text.slice(4, end);
  front = front.replace(/\nexternal:\n(?:[ \t]+.*\n)*/g, "\n");
  const block =
    "external:\n" +
    `  provider: ${external.provider}\n` +
    `  key: ${JSON.stringify(external.key)}\n` +
    `  url: ${JSON.stringify(external.url ?? "")}\n`;
  front = `${front.trimEnd()}\n${block}`;
  writeFileSync(story.path, `---\n${front}---${text.slice(end + 4)}`, "utf8");
  story.meta.external = { ...external };
}

// --------------------------------------------------------------------------
// Labels
// --------------------------------------------------------------------------
/** Managed labels for the facets the tracker can display and filter. */
export function managedLabels(meta: d.Obj, cfg: BacklogConfig): string[] {
  const prefix = labelPrefix(cfg);
  const labels = [
    prefix,
    `${prefix}-status-${String(meta.status ?? "draft").toLowerCase()}`,
    `${prefix}-priority-${String(meta.priority ?? "should").toLowerCase()}`,
    `${prefix}-type-${String(meta.type ?? "story").toLowerCase()}`,
  ];
  if (meta.context) labels.push(`${prefix}-context-${String(meta.context).toLowerCase()}`);
  if (meta.size) labels.push(`${prefix}-size-${String(meta.size).toLowerCase()}`);
  if (meta.risk) labels.push(`${prefix}-risk-${String(meta.risk).toLowerCase()}`);
  for (const label of list(meta.labels)) {
    if (isManagedLabel(label, prefix)) continue;
    // Jira labels allow only letters, numbers and a few separators. The original label is in the machine block;
    // the sanitized one is only there to filter and search.
    labels.push(cfg.provider === "jira" ? sanitizeJiraLabel(label) : label);
  }
  return [...new Set(labels)];
}

/** The facet value from a managed label, or undefined. */
function labelFacet(labels: string[], prefix: string, facet: string): string | undefined {
  const head = `${prefix}-${facet}-`;
  return labels.find((label) => label.startsWith(head))?.slice(head.length);
}

// --------------------------------------------------------------------------
// Story ↔ issue
// --------------------------------------------------------------------------
/** The machine-readable block appended to the issue body. Jira Cloud drops HTML comments in ADF, so it gets a code
 * block there; GitHub keeps the block out of the rendered issue with an HTML comment. */
export function metaBlock(meta: d.Obj, provider: "local" | "github" | "jira"): string {
  const copy: d.Obj = { ...meta };
  delete copy.external;
  const yaml = stringifyYaml(copy, { lineWidth: 0 }).trimEnd();
  return provider === "jira"
    ? `\`\`\`kataster-story\n${yaml}\n\`\`\``
    : `<!-- kataster:story\n${yaml}\n-->`;
}

/** Renders the issue for a story. The title keeps the stable id so test titles stay findable. */
export function renderIssue(story: d.Story, cfg: BacklogConfig): IssuePayload {
  const meta = { ...story.meta };
  delete meta.external;
  return {
    title: `${d.storyId(story)}: ${String(meta.title ?? "")}`.trim(),
    body: `${story.body.trimEnd()}\n\n${metaBlock(meta, cfg.provider)}\n`,
    labels: managedLabels(story.meta, cfg),
    status: String(story.meta.status ?? "draft"),
  };
}

export interface ParsedStory {
  id: string;
  meta: d.Obj;
  body: string;
}

/**
 * Rebuilds a story from an issue. The tracker's fields win where they exist; the machine block fills the rest.
 * `fallbackId` is used for issues that were not created by Kataster and carry no `ST-NNN` in the title.
 */
export function parseIssue(
  issue: RemoteIssue,
  cfg: BacklogConfig,
  { contexts = [], fallbackId = "" }: { contexts?: string[]; fallbackId?: string } = {},
): ParsedStory {
  const match = META_RE.exec(issue.body);
  let meta: d.Obj = {};
  if (match) {
    try {
      const parsed = parseYaml(match[1] ?? match[2]);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) meta = parsed as d.Obj;
    } catch {
      // a broken machine block is not fatal: the title, labels and body still carry the story
    }
  }
  const prefix = labelPrefix(cfg);
  const labels = list(issue.labels);
  const body = (match ? issue.body.replace(META_RE, "") : issue.body).trim();

  const id = String(meta.id ?? ID_PREFIX_RE.exec(issue.title)?.[1] ?? fallbackId).toUpperCase();
  const title = issue.title.replace(ID_PREFIX_RE, "").trim() || String(meta.title ?? id);
  const type = labelFacet(labels, prefix, "type") ?? meta.type ?? "story";
  const contextLabel = labelFacet(labels, prefix, "context");
  const context =
    (contextLabel ? contexts.find((known) => known.toLowerCase() === contextLabel) : undefined) ??
    (typeof meta.context === "string" ? meta.context : "");
  const priority =
    (cfg.provider === "jira" ? reversePriority(issue.priority, cfg) : undefined) ??
    labelFacet(labels, prefix, "priority") ??
    meta.priority ??
    "should";
  const size = labelFacet(labels, prefix, "size")?.toUpperCase() ?? meta.size ?? null;
  const risk = labelFacet(labels, prefix, "risk") ?? meta.risk ?? null;
  const status = statusFromIssue(issue, labels, meta, cfg);
  const userLabels = cfg.provider === "jira" ? jiraUserLabels(labels, prefix, meta) : labels.filter((label) => !isManagedLabel(label, prefix));

  const clean: d.Obj = {
    ...meta,
    id,
    title,
    type,
    context,
    priority,
    size,
    risk,
    events: list(meta.events),
    depends_on: list(meta.depends_on),
    labels: userLabels,
    status,
  };
  if (cfg.provider !== "local") {
    clean.external = { provider: cfg.provider, key: issue.key, ...(issue.url ? { url: issue.url } : {}) };
  }
  // Keep a stable key order: identity, classification, workflow, links, then the external reference.
  const ordered: d.Obj = {
    id: clean.id,
    title: clean.title,
    type: clean.type,
    context: clean.context,
    priority: clean.priority,
    size: clean.size,
    risk: clean.risk,
    events: clean.events,
    depends_on: clean.depends_on,
    labels: clean.labels,
    status: clean.status,
    ...(clean.external ? { external: clean.external } : {}),
  };
  return { id, meta: ordered, body };
}

function reversePriority(priority: string | undefined, cfg: BacklogConfig): string | undefined {
  if (!priority) return undefined;
  return Object.entries(cfg.jira.priorityMap).find(([, name]) => name.toLowerCase() === priority.toLowerCase())?.[0];
}

/**
 * Jira labels are sanitized, so the original labels live in the machine block. The issue stays authoritative for
 * additions and removals: an original label survives only when its sanitized form is still on the issue, and a label
 * added in Jira is kept as it is. An empty label list is treated as "labels were not part of the fetch" and leaves the
 * story's labels alone.
 */
function jiraUserLabels(labels: string[], prefix: string, meta: d.Obj): string[] {
  const fromIssue = labels.filter((label) => !isManagedLabel(label, prefix));
  const original = list(meta.labels);
  if (!original.length) return fromIssue;
  if (!fromIssue.length) return original;
  const known = new Map(original.map((label) => [sanitizeJiraLabel(label), label]));
  return [
    ...original.filter((label) => fromIssue.includes(sanitizeJiraLabel(label))),
    ...fromIssue.filter((label) => !known.has(label)),
  ];
}

function statusFromIssue(issue: RemoteIssue, labels: string[], meta: d.Obj, cfg: BacklogConfig): string {
  const prefix = labelPrefix(cfg);
  const fromLabel = labelFacet(labels, prefix, "status");
  const known = (value: string | undefined): value is string =>
    value !== undefined && (d.STATUSES as readonly string[]).includes(value);

  if (cfg.provider === "github") {
    if (issue.state === "closed") return fromLabel === "superseded" ? "superseded" : "done";
    return known(fromLabel) ? fromLabel : known(meta.status) ? meta.status : "draft";
  }
  if (cfg.provider === "jira" && issue.status) {
    const local = Object.entries(cfg.jira.statusMap).find(([, name]) => name.toLowerCase() === issue.status!.toLowerCase())?.[0];
    if (known(local)) return local;
  }
  return known(fromLabel) ? fromLabel : known(meta.status) ? meta.status : "draft";
}

// --------------------------------------------------------------------------
// Files
// --------------------------------------------------------------------------
export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/ß/g, "ss")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return slug || "story";
}

export function nextStoryId(): string {
  const ids = d.loadStories().parsed.map(d.storyId).filter(Boolean);
  const max = Math.max(0, ...ids.map((id) => Number(id.slice(3)) || 0));
  return `ST-${String(max + 1).padStart(3, "0")}`;
}

export function bumpStoryId(id: string): string {
  return `ST-${String((Number(id.slice(3)) || 0) + 1).padStart(3, "0")}`;
}

/** Writes a story file, reusing the existing path when the id is already mirrored. */
export function writeStory(id: string, meta: d.Obj, body: string, existing?: d.Story): string {
  const { external, ...rest } = meta;
  const clean: d.Obj = { ...rest, id, ...(external ? { external } : {}) };
  const text = `---\n${stringifyYaml(clean, { lineWidth: 0 }).trimEnd()}\n---\n\n${body.trimEnd()}\n`;
  const path = existing?.path ?? join(d.STORIES_DIR, `${id}-${slugify(String(clean.title ?? "story"))}.md`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
  return path;
}

/** Backs up a mirror story before a tracker pull overwrites it. */
export function backupStory(story: d.Story): string {
  const stamp = new Date().toISOString().replaceAll(":", "-").replace(/\..+$/, "");
  const dir = join(d.ROOT, ".kataster", "backup", "backlog", stamp);
  mkdirSync(dir, { recursive: true });
  const target = join(dir, story.path.split(/[\\/]/).pop() ?? "story.md");
  copyFileSync(story.path, target);
  return d.rel(target);
}

/** Content hash of a story file, and the same for an issue payload. */
export function contentHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export function storyHash(story: d.Story): string {
  return contentHash(readFileSync(story.path, "utf8"));
}

export function payloadHash(payload: IssuePayload): string {
  return contentHash(JSON.stringify({
    title: payload.title,
    body: payload.body,
    labels: [...payload.labels].sort(),
    status: payload.status,
  }));
}

/** The story's payload as it is represented remotely. */
export function remotePayload(issue: RemoteIssue, cfg: BacklogConfig): IssuePayload {
  const parsed = parseIssue(issue, cfg);
  return {
    title: issue.title,
    body: issue.body,
    labels: [...issue.labels].sort(),
    status: parsed.meta.status,
  };
}

// --------------------------------------------------------------------------
// Sync state (`.claude/state/backlog-sync.json`)
// --------------------------------------------------------------------------
export interface SyncEntry {
  key: string;
  url?: string;
  /** Hash of the local story file at the last successful sync. */
  localHash: string;
  /** Hash of the remote issue payload at the last successful sync (empty until the first pull). */
  remoteHash: string;
}

export interface SyncState {
  provider: string;
  updatedAt: string;
  stories: Record<string, SyncEntry>;
}

const STATE_FILE = join(d.ROOT, ".claude", "state", "backlog-sync.json");

export function readSyncState(): SyncState {
  try {
    const raw = JSON.parse(readFileSync(STATE_FILE, "utf8")) as Partial<SyncState>;
    return {
      provider: typeof raw.provider === "string" ? raw.provider : "local",
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "",
      stories: raw.stories !== null && typeof raw.stories === "object" ? (raw.stories as Record<string, SyncEntry>) : {},
    };
  } catch {
    return { provider: "local", updatedAt: "", stories: {} };
  }
}

export function writeSyncState(state: SyncState): void {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, `${JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2)}\n`, "utf8");
}

/** The state for one provider; a provider switch starts from scratch instead of comparing unrelated hashes. */
export function readProviderState(provider: string): SyncState {
  const state = readSyncState();
  return state.provider === provider ? state : { provider, updatedAt: "", stories: {} };
}

/** Everything the sync needs from the event storming: bounded-context IDs for label round-trips. */
export function knownContexts(): string[] {
  const model = d.loadEventsModel();
  if (!model) return [];
  return ((model.bounded_contexts ?? []) as d.Obj[])
    .map((bc) => bc.id)
    .filter((id): id is string => typeof id === "string");
}

