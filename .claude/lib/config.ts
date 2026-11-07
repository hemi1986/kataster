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

export interface ResearchGateConfig {
  /** Story risks that require at least one `sources:` entry before `ready-for-human-review`. */
  risk: string[];
  /** Story labels that require a source; a label matches exactly or by prefix (`security` matches `security:oauth`). */
  labels: string[];
}

export interface ResearchConfig {
  /** Months a research file stays valid; used when a file is written or refreshed. */
  expiryMonths: number;
  gate: ResearchGateConfig;
}

export const DEFAULT_RESEARCH_CONFIG: ResearchConfig = {
  expiryMonths: 12,
  gate: {
    risk: ["high"],
    labels: ["security", "auth", "payment", "privacy"],
  },
};

export const DEFAULT_LABEL_PREFIX = "kataster";

export const DEFAULT_STATUS_MAP: Record<string, string> = {
  draft: "To Do",
  review: "In Review",
  "ready-for-human-review": "Ready for Review",
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

function stringList(value: unknown, fallback: string[], lowercase = false): string[] {
  if (!Array.isArray(value)) return [...fallback];
  const out = value
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.trim())
    .filter(Boolean)
    .map((v) => (lowercase ? v.toLowerCase() : v));
  return [...new Set(out)];
}

/**
 * Reads `.claude/project.json` → `research`. Profiles from before 0.6 have no block and get the defaults, so an
 * upgrade does not change the gate. An explicit empty list turns that part of the gate off.
 */
export function loadResearchConfig(): ResearchConfig {
  const raw = (loadProfile().research ?? {}) as Obj;
  const gate = (raw.gate ?? {}) as Obj;
  const months = Number(raw.expiryMonths);
  return {
    expiryMonths: Number.isFinite(months) && months > 0 ? months : DEFAULT_RESEARCH_CONFIG.expiryMonths,
    gate: {
      risk: stringList(gate.risk, DEFAULT_RESEARCH_CONFIG.gate.risk, true),
      labels: stringList(gate.labels, DEFAULT_RESEARCH_CONFIG.gate.labels, true),
    },
  };
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
