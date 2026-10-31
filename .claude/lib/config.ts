/**
 * Project profile and backlog configuration.
 *
 * `.claude/project.json` is the only place for project facts. The backlog section says where stories live:
 *
 *   local   – `docs/stories/` is the backlog (the default, no tracker)
 *   github  – GitHub Issues are the source of truth, `docs/stories/` is the local mirror
 *   jira    – Jira is the source of truth, `docs/stories/` is the local mirror
 *
 * Only runtime dependency: Node >= 22.18 (type stripping). No imports from discovery.ts – that would create a
 * cycle, because discovery.ts reads the backlog configuration to validate mirrored stories.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const ROOT = resolve(import.meta.dirname, "..", "..");

export type BacklogProvider = "local" | "github" | "jira";

export interface GitHubConfig {
  /** `owner/name`; empty means "the repository gh is run in". */
  repo: string;
  /** Prefix of the labels the sync manages (`kataster-status-ready`, `kataster-priority-must`, …). */
  labelPrefix: string;
}

export interface JiraConfig {
  /** Name of the MCP server as configured in the harness, normally `mcp-atlassian`. */
  mcpServer: string;
  /** Jira project key, e.g. `PROJ`. */
  project: string;
  /** Issue type used for stories, e.g. `Story`, `Task` or `Bug`. */
  issueType: string;
  labelPrefix: string;
  /** Local workflow status → Jira status name. Must match the project's workflow. */
  statusMap: Record<string, string>;
  /** Local MoSCoW priority → Jira priority name. */
  priorityMap: Record<string, string>;
}

export interface BacklogConfig {
  provider: BacklogProvider;
  github: GitHubConfig;
  jira: JiraConfig;
}

export const DEFAULT_LABEL_PREFIX = "kataster";

export const DEFAULT_STATUS_MAP: Record<string, string> = {
  draft: "To Do",
  review: "In Review",
  ready: "Ready",
  "in-progress": "In Progress",
  done: "Done",
  superseded: "Won't Do",
};

export const DEFAULT_PRIORITY_MAP: Record<string, string> = {
  must: "Highest",
  should: "High",
  could: "Medium",
  wont: "Lowest",
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Obj = Record<string, any>;

/** The project profile, or an empty object when it is missing or unreadable. */
export function loadProfile(): Obj {
  try {
    const data = JSON.parse(readFileSync(join(ROOT, ".claude", "project.json"), "utf8"));
    return data !== null && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

function provider(value: unknown): BacklogProvider {
  return value === "github" || value === "jira" ? value : "local";
}

function str(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function map(value: unknown, fallback: Record<string, string>): Record<string, string> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? { ...fallback, ...(value as Record<string, string>) }
    : { ...fallback };
}

/** Reads `.claude/project.json` → `backlog`. Missing values fall back to the local provider. */
export function loadBacklogConfig(): BacklogConfig {
  const raw = (loadProfile().backlog ?? {}) as Obj;
  const github = (raw.github ?? {}) as Obj;
  const jira = (raw.jira ?? {}) as Obj;
  return {
    provider: provider(raw.provider),
    github: {
      repo: str(github.repo, ""),
      labelPrefix: str(github.labelPrefix, DEFAULT_LABEL_PREFIX),
    },
    jira: {
      mcpServer: str(jira.mcpServer, "mcp-atlassian"),
      project: str(jira.project, ""),
      issueType: str(jira.issueType, "Story"),
      labelPrefix: str(jira.labelPrefix, DEFAULT_LABEL_PREFIX),
      statusMap: map(jira.statusMap, DEFAULT_STATUS_MAP),
      priorityMap: map(jira.priorityMap, DEFAULT_PRIORITY_MAP),
    },
  };
}

/** Prefix used by the active provider's managed labels. */
export function labelPrefix(cfg: BacklogConfig): string {
  return cfg.provider === "jira" ? cfg.jira.labelPrefix : cfg.github.labelPrefix;
}

/** A label the sync owns; stories may not use it themselves. */
export function isManagedLabel(label: string, prefix: string): boolean {
  return label === prefix || label.startsWith(`${prefix}-`);
}
