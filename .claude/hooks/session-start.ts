/**
 * SessionStart hook: what a fresh checkout is still missing (only what is missing),
 * and where the work stands – branch, stories in progress, the next story, the last verify result.
 *
 * Everything project-specific comes from `.claude/project.json`; this file contains no project knowledge.
 * The setup checks run before anything is imported from .claude/lib, so they still work when the
 * tooling dependencies are not installed yet.
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const root = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();

type Profile = {
  name?: string;
  kind?: "greenfield" | "brownfield";
  languages?: { artifacts?: string; ui?: string };
  commands?: { install?: string };
  review?: { preview?: string; pullRequest?: string };
  setup?: { envFile?: string; envHint?: string };
  backlog?: {
    provider?: "local" | "github" | "jira";
    jira?: { project?: string; mcpServer?: string };
    github?: { repo?: string };
  };
};

function profile(): Profile {
  try {
    return JSON.parse(readFileSync(join(root, ".claude", "project.json"), "utf8")) as Profile;
  } catch {
    return {};
  }
}

/** Runs a command with stderr folded into stdout; `ok` is the exit status. */
function sh(command: string): { ok: boolean; out: string } {
  try {
    return { ok: true, out: execSync(`${command} 2>&1`, { cwd: root, encoding: "utf8", timeout: 5000 }).trim() };
  } catch (e) {
    const err = e as { stdout?: string };
    return { ok: false, out: (err.stdout ?? "").trim() };
  }
}

type McpApproval = {
  mcpServers?: Record<string, unknown>;
  enableAllProjectMcpServers?: boolean;
  enabledMcpjsonServers?: string[];
  disabledMcpjsonServers?: string[];
};

/** A JSON settings file, or nothing when it is missing, unreadable or too large to bother. */
function readJson(path: string): Record<string, unknown> | undefined {
  try {
    if (statSync(path).size > 50_000_000) return undefined;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * Is the preview MCP server from .mcp.json approved for this project? The approval can live in the project's
 * entry of ~/.claude.json or in any settings file (user, project, local – the "approve" dialog writes
 * .claude/settings.local.json). undefined = can't tell.
 */
function mcpApproved(server: string): boolean | undefined {
  const global = readJson(join(homedir(), ".claude.json"));
  const sources: McpApproval[] = [
    (global?.projects as Record<string, McpApproval> | undefined)?.[root],
    readJson(join(homedir(), ".claude/settings.json")),
    readJson(join(root, ".claude", "settings.json")),
    readJson(join(root, ".claude", "settings.local.json")),
  ].filter((source): source is McpApproval => source !== undefined);
  if (sources.length === 0) return undefined;
  if (sources.some((source) => source.disabledMcpjsonServers?.includes(server))) return false;
  return sources.some(
    (source) =>
      Boolean(source.mcpServers?.[server]) ||
      source.enableAllProjectMcpServers === true ||
      source.enabledMcpjsonServers?.includes(server),
  );
}

/** Is an MCP server with this name configured anywhere the harness reads? */
function mcpConfigured(server: string): boolean {
  for (const file of [".mcp.json", ".claude/settings.json", ".claude/settings.local.json", ".opencode/opencode.jsonc", ".opencode/opencode.json"]) {
    const path = join(root, file);
    try {
      if (existsSync(path) && readFileSync(path, "utf8").includes(server)) return true;
    } catch {
      // an unreadable config never blocks a session start
    }
  }
  return false;
}

function setupHints(p: Profile): string[] {
  const hints: string[] = [];

  if (!existsSync(join(root, ".claude/node_modules/yaml")))
    hints.push("- Tooling dependencies are missing – the validators and scripts won't run: `npm install --prefix .claude`");

  const install = p.commands?.install;
  if (install && existsSync(join(root, "package.json")) && !existsSync(join(root, "node_modules")))
    hints.push(`- The application's dependencies are missing: \`${install}\``);

  if (p.review?.pullRequest === "gh") {
    if (!sh("command -v gh").ok) {
      hints.push("- GitHub CLI (`gh`) not installed – /implement can't open the pull request itself, it falls back to the compare URL from `git push`: https://cli.github.com");
    } else {
      const auth = sh("gh auth status");
      if (!auth.ok) hints.push("- `gh` is not authenticated – no pull requests from here: `gh auth login` (needs the `repo` scope)");
      else if (!/Token scopes:.*'repo'/.test(auth.out)) hints.push("- The `gh` token has no `repo` scope – creating pull requests will fail: `gh auth refresh -s repo`");
    }
  }

  const backlog = p.backlog?.provider ?? "local";
  if (backlog === "github" && p.review?.pullRequest !== "gh") {
    if (!sh("command -v gh").ok)
      hints.push("- Backlog provider is `github`, but the GitHub CLI (`gh`) is missing – the mirror cannot sync: https://cli.github.com");
    else if (!sh("gh auth status").ok)
      hints.push("- Backlog provider is `github`, but `gh` is not authenticated – `gh auth login` (needs the `repo` scope).");
  }
  if (backlog === "jira") {
    const project = p.backlog?.jira?.project ?? "";
    const server = p.backlog?.jira?.mcpServer ?? "mcp-atlassian";
    if (!project) hints.push("- Backlog provider is `jira`, but `backlog.jira.project` is empty in `.claude/project.json`.");
    if (!mcpConfigured(server))
      hints.push(
        `- Backlog provider is \`jira\`, but no \`${server}\` MCP server is configured in this project. ` +
          "Add it in your harness (see the `backlog` skill), otherwise no story can be read from or written to Jira.",
      );
  }

  if (p.review?.preview === "vercel" && existsSync(join(root, ".mcp.json")) && mcpApproved("vercel") === false)
    hints.push(
      "- Vercel MCP (`vercel` in .mcp.json) is not enabled yet: approve the project server, then authenticate it. " +
        "It gives preview deployment status and build/runtime logs for the acceptance step; without it, ask the user for the preview URL.",
    );

  if (p.setup?.envFile && !existsSync(join(root, p.setup.envFile)))
    hints.push(`- No ${p.setup.envFile} – ${p.setup.envHint ?? "the app may not start"}`);

  if (!existsSync(join(root, "CONTEXT.md")))
    hints.push(
      `- Discovery has not started: no CONTEXT.md. Run \`${p.kind === "brownfield" ? "/adopt" : "/bootstrap"}\` to build the domain model with the user.`,
    );

  if (p.kind === "brownfield" && !existsSync(join(root, "docs", "architecture", "repo-map.json")))
    hints.push(
      "- No repository map yet: `/adopt` maps the repository first, then adopts one slice at a time (one domain plus at most one shared library).",
    );

  return hints;
}

const p = profile();
const name = p.name ?? "this project";
const lines: string[] = [];

try {
  const hints = setupHints(p);
  if (hints.length > 0) lines.push(`${name} – setup (tell the user, don't fix it silently):`, ...hints, "");
} catch {
  // a broken check never blocks a session start
}

try {
  const { rel, storyId, loadStories } = await import("../lib/discovery.ts");
  const { git, nextStory, readVerifyState } = await import("../lib/engineering.ts");

  lines.push(`${name} – engineering status:`);
  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  const dirty = (git("status", "--porcelain") ?? "") !== "";
  lines.push(`- Branch: ${branch ?? "?"}${dirty ? " (uncommitted changes)" : ""}`);

  const provider = p.backlog?.provider ?? "local";
  if (provider !== "local") {
    const stories = loadStories().parsed;
    const unlinked = stories.filter((story) => {
      const ext = story.meta.external as { provider?: unknown; key?: unknown } | undefined;
      return !ext || ext.provider !== provider || typeof ext.key !== "string" || !ext.key;
    }).length;
    const target = provider === "jira" ? `Jira (${p.backlog?.jira?.project || "project not configured"})` : "GitHub Issues";
    lines.push(
      `- Backlog: ${target} – ${stories.length - unlinked} of ${stories.length} stories linked` +
        (unlinked ? `; ${unlinked} need /backlog-sync` : ""),
    );
  }

  const { inProgress, next } = nextStory();
  for (const s of inProgress) lines.push(`- In progress: ${storyId(s)} – ${s.meta.title} (${rel(s.path)})`);
  if (next) lines.push(`- Next ready story: ${storyId(next)} – ${next.meta.title} (start with /implement)`);
  if (!inProgress.length && !next && !existsSync(join(root, "docs", "stories")))
    lines.push("- No backlog yet – discovery comes first (/bootstrap or /adopt).");

  const v = readVerifyState();
  if (v) {
    const head = git("rev-parse", "--short", "HEAD");
    const stale = v.commit !== head || v.dirty ? " – older than the current code" : "";
    const failed = v.steps.filter((s) => !s.ok).map((s) => s.name);
    lines.push(`- Last verify: ${v.ok ? "green" : `RED (${failed.join(", ")})`} at ${v.at} on ${v.branch}@${v.commit}${stale}`);
  }
} catch {
  // never block a session start
}

if (lines.length > 0) console.log(lines.join("\n"));
process.exit(0);
