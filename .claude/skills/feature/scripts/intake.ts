/**
 * Read-only intake for `/feature`.
 *
 * Turns a story id, a GitHub/Jira issue, a pasted URL or free text into a normalized source plus a routing hint.
 * It never writes: no story, no mirror, no sync state. The skill decides what to do with the result.
 *
 *   node .claude/skills/feature/scripts/intake.ts ST-042 --json
 *   node .claude/skills/feature/scripts/intake.ts #123 --json
 *   node .claude/skills/feature/scripts/intake.ts PROJ-123 --from jira-issues.json --json
 *   node .claude/skills/feature/scripts/intake.ts "customers attach photos to orders" --json
 *
 * Jira is reached through `mcp-atlassian`, which only the agent can call. The agent fetches the issue with MCP,
 * writes it as JSON and passes it with `--from` – the same split the backlog sync uses.
 */
import { readFileSync } from "node:fs";
import { loadBacklogConfig, type BacklogConfig } from "../../../lib/config.ts";
import * as d from "../../../lib/discovery.ts";
import { externalOf, type RemoteIssue } from "../../../lib/backlog.ts";
import { readGithubIssue } from "../../../lib/backlog-github.ts";
import { normalizeJiraIssue } from "../../../lib/backlog-jira.ts";

type Route = "continue-story" | "review-story" | "implement-story" | "new-story" | "bug" | "feature";
type SourceKind = "story" | "github" | "jira" | "text";

interface Source {
  kind: SourceKind;
  ref: string;
  title?: string;
  url?: string;
  status?: string;
  labels: string[];
  body?: string;
}

interface StoryRef {
  id: string;
  path: string;
  title: string;
  status: string;
  type: string;
}

interface Intake {
  source: Source;
  story: StoryRef | null;
  route: Route;
  reason: string;
  signals: {
    bug: boolean;
    scenarios: number;
    checklistItems: number;
    openQuestions: number;
  };
  warnings: string[];
}

const BUG_LABELS = new Set(["bug", "defect", "regression"]);
const GH_URL = /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/issues\/(\d+)(?:[?#].*)?$/i;
const JIRA_URL = /^https?:\/\/[^/\s]+\/browse\/([A-Z][A-Z0-9_]+-\d+)(?:[?#].*)?$/i;

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

function count(re: RegExp, text: string): number {
  return (text.match(re) ?? []).length;
}

/** A bug is a hint for the routing, never a verdict – the grilling decides. */
function looksLikeBug(title: string, labels: string[], issueType = ""): boolean {
  if (labels.some((label) => BUG_LABELS.has(label.toLowerCase()))) return true;
  if (/^bug$/i.test(issueType)) return true;
  return /^\s*(?:\[bug\]|bug\b|fix\b)/i.test(title);
}

function findStory(id: string): d.Story | null {
  const wanted = id.toUpperCase();
  return d.loadStories().parsed.find((story) => d.storyId(story).toUpperCase() === wanted) ?? null;
}

function findLinked(kind: "github" | "jira", key: string): d.Story | null {
  const wanted = kind === "github" ? key : key.toUpperCase();
  return d.loadStories().parsed.find((story) => {
    const ext = externalOf(story);
    if (!ext || ext.provider !== kind) return false;
    return (kind === "github" ? ext.key : ext.key.toUpperCase()) === wanted;
  }) ?? null;
}

function storyRef(story: d.Story): StoryRef {
  return {
    id: d.storyId(story),
    path: d.rel(story.path),
    title: String(story.meta.title ?? ""),
    status: String(story.meta.status ?? ""),
    type: String(story.meta.type ?? "story"),
  };
}

function routeFor(story: d.Story | null, bug: boolean): { route: Route; reason: string } {
  if (story) {
    const id = d.storyId(story);
    switch (String(story.meta.status ?? "")) {
      case "draft":
        return { route: "continue-story", reason: `${id} is a draft – revise it instead of creating a parallel feature` };
      case "review":
        return { route: "review-story", reason: `${id} is waiting for its review – run /review-stories ${id} or revise it` };
      case "ready":
        return { route: "implement-story", reason: `${id} is ready – continue with /implement ${id}` };
      case "in-progress":
        return { route: "implement-story", reason: `${id} is in progress – continue with /implement ${id}` };
      default: {
        const status = String(story.meta.status ?? "not open");
        return {
          route: "new-story",
          reason: `${id} is ${status} – finished work is final, so this becomes a new story`,
        };
      }
    }
  }
  if (bug) {
    return { route: "bug", reason: "flagged as a bug – restore documented behaviour, do not run feature discovery" };
  }
  return { route: "feature", reason: "new or changed behaviour – run the feature pipeline" };
}

function loadJiraIssues(path: string): { issue: RemoteIssue; raw: d.Obj }[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`Jira: could not read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const list = Array.isArray(raw)
    ? raw
    : (raw as d.Obj | null)?.issues ?? (raw as d.Obj | null)?.values ?? (raw as d.Obj | null)?.results ?? [];
  if (!Array.isArray(list)) fail(`Jira: ${path} must contain an array of issues (or { "issues": [...] })`);
  return list.flatMap((item) => {
    if (item === null || typeof item !== "object") return [];
    const issue = normalizeJiraIssue(item as d.Obj);
    return issue ? [{ issue, raw: item as d.Obj }] : [];
  });
}

function jiraIssueType(raw: d.Obj): string {
  const fields = (raw.fields ?? raw) as d.Obj;
  const type = fields.issuetype ?? fields.issue_type ?? raw.issuetype;
  if (typeof type === "string") return type;
  return typeof type?.name === "string" ? type.name : "";
}

function summarize(source: Source, body: string): Pick<Intake, "signals"> {
  return {
    signals: {
      bug: looksLikeBug(source.title ?? "", source.labels),
      scenarios: count(/\bScenario(?: Outline| Template)?\s*:/g, body),
      checklistItems: count(/^\s*[-*]\s*\[[ xX]\]/gm, body),
      openQuestions: count(/\[OPEN\]/g, body),
    },
  };
}

interface JiraHit {
  source: Source;
  linked: d.Story | null;
  body: string;
  jiraType: string;
}

function loadJira(key: string, from: string, cfg: BacklogConfig, warnings: string[]): JiraHit {
  if (!from) {
    fail(
      `Jira ${key}: Jira is reached through mcp-atlassian, which only the agent can call.\n` +
        "  Fetch the issue with jira_get_issue, write it as JSON, then:\n" +
        `  node .claude/skills/feature/scripts/intake.ts ${key} --from <issue.json>`,
    );
  }
  const issues = loadJiraIssues(from);
  const hit = issues.find((entry) => entry.issue.key.toUpperCase() === key) ??
    (issues.length === 1 ? issues[0] : undefined);
  if (!hit) {
    fail(
      `Jira ${key}: no matching issue in ${from}` +
        `${issues.length ? ` (found ${issues.map((i) => i.issue.key).join(", ")})` : ""}.`,
    );
  }
  if (cfg.provider !== "jira") {
    warnings.push(`configured backlog provider is '${cfg.provider}' – the issue is read as evidence only`);
  }
  return {
    source: {
      kind: "jira",
      ref: hit.issue.key,
      title: hit.issue.title,
      url: hit.issue.url,
      status: hit.issue.status,
      labels: hit.issue.labels,
      body: hit.issue.body,
    },
    linked: findLinked("jira", hit.issue.key),
    body: hit.issue.body,
    jiraType: jiraIssueType(hit.raw),
  };
}

function main(): void {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const fromIndex = args.indexOf("--from");
  const from = fromIndex >= 0 ? args[fromIndex + 1] ?? "" : "";
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--json") continue;
    if (args[i] === "--from") {
      i++;
      continue;
    }
    positional.push(args[i]);
  }
  const input = positional.join(" ").trim();

  if (!input) {
    fail(
      "Usage: node .claude/skills/feature/scripts/intake.ts <ST-NNN | #issue | PROJ-123 | URL | idea> " +
        "[--from <jira-issues.json>] [--json]",
    );
  }

  const cfg: BacklogConfig = loadBacklogConfig();
  const warnings: string[] = [];
  let source: Source;
  let body = "";
  let linked: d.Story | null = null;
  let jiraType = "";

  const storyMatch = /^(ST-\d{3,})$/i.exec(input);
  const ghUrl = GH_URL.exec(input);
  const jiraUrl = JIRA_URL.exec(input);
  const ghRef = /^#(\d+)$/.exec(input);
  const jiraRef = /^([A-Z][A-Z0-9_]+-\d+)$/.exec(input);

  if (storyMatch) {
    const id = storyMatch[1].toUpperCase();
    const story = findStory(id);
    if (story) {
      linked = story;
      body = story.body;
      source = {
        kind: "story",
        ref: id,
        title: String(story.meta.title ?? ""),
        status: String(story.meta.status ?? ""),
        labels: Array.isArray(story.meta.labels) ? story.meta.labels.map(String) : [],
        body: story.body,
      };
    } else if (from) {
      // `ST-` is the story prefix, but a Jira project may use the same key – the export disambiguates.
      const hit = loadJira(id, from, cfg, warnings);
      source = hit.source;
      linked = hit.linked;
      body = hit.body;
      jiraType = hit.jiraType;
    } else {
      fail(`Story ${id} not found in docs/stories/.`);
    }
  } else if (ghRef || ghUrl) {
    const key = ghRef ? ghRef[1] : ghUrl![3];
    const repo = ghUrl ? `${ghUrl[1]}/${ghUrl[2]}` : undefined;
    let issue: RemoteIssue | null;
    try {
      issue = readGithubIssue(cfg, key, repo);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/ENOENT|spawnSync gh/i.test(message)) fail("GitHub: the `gh` CLI is not installed or not on PATH.");
      fail(`GitHub: ${message}`);
    }
    if (!issue) fail(`GitHub issue #${key}${repo ? ` in ${repo}` : ""} not found (or not accessible).`);
    if (cfg.provider !== "github") warnings.push(`configured backlog provider is '${cfg.provider}' – the issue is read as evidence only`);
    if (issue.state === "closed") warnings.push("the issue is closed – confirm the work is still wanted");
    body = issue.body;
    source = {
      kind: "github",
      ref: `#${issue.key}`,
      title: issue.title,
      url: issue.url,
      status: issue.state,
      labels: issue.labels,
      body: issue.body,
    };
    linked = findLinked("github", issue.key);
  } else if (jiraRef || jiraUrl) {
    const key = (jiraRef ? jiraRef[1] : jiraUrl![1]).toUpperCase();
    const hit = loadJira(key, from, cfg, warnings);
    source = hit.source;
    linked = hit.linked;
    body = hit.body;
    jiraType = hit.jiraType;
  } else {
    body = input;
    source = {
      kind: "text",
      ref: input,
      title: input.split("\n")[0].slice(0, 120),
      labels: [],
      body: input,
    };
  }

  const { signals } = summarize(source, body);
  if (jiraType && /^bug$/i.test(jiraType)) signals.bug = true;

  if (linked && source.kind !== "story") {
    warnings.push(`linked to ${d.storyId(linked)} – run /backlog-sync pull first so the mirror is current`);
  }
  const broken = d.loadStories().failures.length;
  if (broken) warnings.push(`${broken} story file(s) have broken frontmatter – run the story validator`);

  const { route, reason } = routeFor(linked, signals.bug);
  const result: Intake = {
    source,
    story: linked ? storyRef(linked) : null,
    route,
    reason,
    signals,
    warnings,
  };

  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const lines = [`Source   ${source.kind} ${source.ref}${source.title ? ` – "${source.title}"` : ""}`];
  if (source.url) lines.push(`URL      ${source.url}`);
  if (source.status) lines.push(`Status   ${source.status}`);
  if (source.labels.length) lines.push(`Labels   ${source.labels.join(", ")}`);
  if (result.story) {
    lines.push(`Story    ${result.story.id} "${result.story.title}" (${result.story.status})`);
    lines.push(`Path     ${result.story.path}`);
  }
  lines.push(`Route    ${route}`, `         ${reason}`);
  lines.push(
    `Signals  bug=${signals.bug ? "yes" : "no"} scenarios=${signals.scenarios} ` +
      `checklist=${signals.checklistItems} open=${signals.openQuestions}`,
  );
  for (const warning of warnings) lines.push(`Warning  ${warning}`);
  console.log(lines.join("\n"));
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
