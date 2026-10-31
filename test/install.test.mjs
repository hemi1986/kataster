import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cli = resolve(here, "..", "bin", "kataster.mjs");

function repo(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), "kataster-"));
  for (const [path, content] of Object.entries(files)) {
    const target = join(dir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
  }
  return dir;
}

function run(args, cwd = process.cwd()) {
  const r = spawnSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8" });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const read = (dir, path) => readFileSync(join(dir, path), "utf8");
const json = (dir, path) => JSON.parse(read(dir, path));

test("installs the workflow into an existing repository", () => {
  const dir = repo({
    "package.json": JSON.stringify({ name: "demo", dependencies: { next: "15.0.0", pg: "8.0.0" }, scripts: { test: "vitest", lint: "eslint ." } }),
    "src/index.ts": "export const x = 1;\n",
  });

  const result = run(["init", dir, "--yes", "--no-install"]);
  assert.equal(result.code, 0, result.out);

  for (const file of [
    ".claude/project.json",
    ".claude/install.json",
    ".claude/settings.json",
    ".claude/skills/adopt/SKILL.md",
    ".claude/skills/bootstrap/SKILL.md",
    ".claude/skills/grilling/SKILL.md",
    ".claude/skills/implement/scripts/verify.ts",
    ".claude/skills/feature/scripts/intake.ts",
    ".claude/skills/shape/SKILL.md",
    ".claude/skills/backlog/scripts/backlog-push.ts",
    ".claude/skills/backlog/scripts/jira-plan.ts",
    ".claude/lib/config.ts",
    ".claude/lib/backlog.ts",
    ".claude/lib/backlog-github.ts",
    ".claude/lib/backlog-jira.ts",
    ".claude/lib/discovery.ts",
    ".claude/agents/repo-analyst.md",
    ".opencode/agents/repo-analyst.md",
    ".opencode/commands/adopt.md",
    ".opencode/commands/backlog-sync.md",
    ".opencode/commands/shape.md",
    ".opencode/plugins/kataster/index.ts",
    "AGENTS.md",
    "CLAUDE.md",
    "CONTEXT.md",
    "docs/workflow.md",
    "docs/domain/events.yaml",
    "docs/product/vision.md",
    "docs/product/initiatives/README.md",
    "docs/engineering/conventions.md",
    "docs/stories/README.md",
  ]) {
    assert.ok(existsSync(join(dir, file)), `${file} missing`);
  }

  const profile = json(dir, ".claude/project.json");
  assert.equal(profile.kind, "brownfield");
  assert.equal(profile.name, "demo");
  assert.deepEqual(profile.stack.frameworks, ["Next.js"]);
  assert.deepEqual(profile.stack.databases, ["PostgreSQL"]);
  assert.equal(profile.commands.lint, "npm run lint");
  assert.equal(profile.backlog.provider, "local");

  assert.match(read(dir, "CONTEXT.md"), /^# demo/m);
  assert.match(read(dir, "docs/domain/events.yaml"), /domain: demo/);
  assert.match(read(dir, "AGENTS.md"), /kataster:begin/);

  const settings = json(dir, ".claude/settings.json");
  assert.ok(settings.hooks.SessionStart[0].hooks[0].command.includes("session-start.ts"));
  assert.ok(settings.permissions.allow.some((a) => a.includes("validate-events.ts")));

  const manifest = json(dir, ".claude/install.json");
  assert.equal(manifest.tool, "kataster");
  assert.ok(Object.keys(manifest.files).length > 50);
  assert.ok(!(".claude/project.json" in manifest.files), "project content is not managed");
});

test("detects a greenfield repository and does not touch existing project docs", () => {
  const dir = repo({ "README.md": "# Empty\n", "package.json": "{}" });

  const result = run(["init", dir, "--yes", "--no-install"]);
  assert.equal(result.code, 0, result.out);
  assert.equal(json(dir, ".claude/project.json").kind, "greenfield");
  assert.ok(existsSync(join(dir, "docs/domain/events.yaml")));
});

test("keeps an existing AGENTS.md and settings.json and merges into them", () => {
  const dir = repo({
    "AGENTS.md": "# Our house rules\n\nUse tabs.\n",
    ".claude/settings.json": JSON.stringify({
      permissions: { allow: ["Bash(ls)"], deny: [] },
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "node scripts/own-check.mjs" }] }] },
      env: { FOO: "bar" },
    }),
    "package.json": "{}",
  });

  const result = run(["init", dir, "--yes", "--no-install"]);
  assert.equal(result.code, 0, result.out);

  const agents = read(dir, "AGENTS.md");
  assert.match(agents, /# Our house rules/);
  assert.match(agents, /Use tabs\./);
  assert.match(agents, /kataster:begin/);

  const settings = json(dir, ".claude/settings.json");
  assert.equal(settings.env.FOO, "bar");
  assert.ok(settings.permissions.allow.includes("Bash(ls)"));
  const pre = settings.hooks.PreToolUse;
  assert.ok(pre.some((entry) => JSON.stringify(entry).includes("own-check.mjs")), "foreign hook kept");
  assert.ok(pre.some((entry) => JSON.stringify(entry).includes("protect-files.ts")), "our hook added");
});

test("imports AGENTS.md from an existing CLAUDE.md and keeps the project's .claude files", () => {
  const dir = repo({
    "CLAUDE.md": "# House rules\n\nUse tabs.\n",
    ".claude/skills/team-skill/SKILL.md": "# Team skill\n",
    ".claude/rules/sql.md": "---\npaths:\n  - \"**/*.sql\"\n---\n# SQL\n",
    "package.json": "{}",
  });

  const result = run(["init", dir, "--yes", "--no-install"]);
  assert.equal(result.code, 0, result.out);

  const claude = read(dir, "CLAUDE.md");
  assert.match(claude, /@AGENTS\.md/);
  assert.match(claude, /# House rules/);
  assert.match(claude, /Use tabs\./);
  assert.equal((claude.match(/@AGENTS\.md/g) ?? []).length, 1);

  assert.match(read(dir, ".claude/skills/team-skill/SKILL.md"), /Team skill/);
  assert.match(read(dir, ".claude/rules/sql.md"), /paths:/);

  const upgrade = run(["upgrade", dir, "--no-install"]);
  assert.equal(upgrade.code, 0, upgrade.out);
  assert.equal((read(dir, "CLAUDE.md").match(/@AGENTS\.md/g) ?? []).length, 1);
  assert.match(read(dir, "CLAUDE.md"), /Use tabs\./);
});

test("is idempotent and upgrades without clobbering local edits", () => {
  const dir = repo({ "package.json": "{}" });
  assert.equal(run(["init", dir, "--yes", "--no-install"]).code, 0);

  const skill = join(dir, ".claude/skills/grilling/SKILL.md");
  writeFileSync(skill, `${readFileSync(skill, "utf8")}\nLocal note.\n`, "utf8");

  const upgrade = run(["upgrade", dir, "--no-install"]);
  assert.equal(upgrade.code, 0, upgrade.out);
  assert.match(upgrade.out, /conflict/);
  assert.match(readFileSync(skill, "utf8"), /Local note\./);

  const forced = run(["upgrade", dir, "--no-install", "--force"]);
  assert.equal(forced.code, 0, forced.out);
  assert.doesNotMatch(readFileSync(skill, "utf8"), /Local note\./);
  assert.ok(existsSync(join(dir, ".kataster/backup")));
});

test("dry run writes nothing", () => {
  const dir = repo({ "package.json": "{}" });
  const result = run(["init", dir, "--yes", "--no-install", "--dry-run"]);
  assert.equal(result.code, 0, result.out);
  assert.ok(!existsSync(join(dir, ".claude")));
  assert.ok(!existsSync(join(dir, "CONTEXT.md")));
});

test("doctor reports a missing installation", () => {
  const dir = repo({ "package.json": "{}" });
  const result = run(["doctor", dir]);
  assert.equal(result.code, 1);
  assert.match(result.out, /Workflow installed/);
});

test("upgrade migrates an installation made under the old name", () => {
  const dir = repo({
    "package.json": "{}",
    ".claude/project.json": JSON.stringify({ name: "demo", backlog: { provider: "local" } }),
    ".claude/install.json": JSON.stringify({ tool: "laguardia", version: "0.1.0", files: {} }),
    "AGENTS.md": "# demo\n\n<!-- laguardia:begin – managed by laguardia; edits inside are overwritten on upgrade -->\n## demo – agent workflow (La Guardia)\nold block\n<!-- laguardia:end -->\n",
    "CLAUDE.md": "<!-- laguardia:claude:begin – imports the shared workflow; managed by laguardia -->\n@AGENTS.md\n<!-- laguardia:claude:end -->\n",
    ".gitignore": "node_modules/\n.laguardia/\n",
    ".laguardia/backup/old/story.md": "old backup\n",
    ".opencode/plugins/laguardia/index.ts": "// old adapter\n",
  });

  const result = run(["upgrade", dir, "--no-install"]);
  assert.equal(result.code, 0, result.out);

  assert.ok(!existsSync(join(dir, ".laguardia")), "old state directory must be gone");
  assert.equal(read(dir, ".kataster/backup/old/story.md"), "old backup\n");
  assert.ok(!existsSync(join(dir, ".opencode/plugins/laguardia")), "old plugin path must be gone");
  assert.ok(existsSync(join(dir, ".opencode/plugins/kataster/index.ts")));

  const agents = read(dir, "AGENTS.md");
  assert.match(agents, /kataster:begin/);
  assert.doesNotMatch(agents, /laguardia/);
  assert.equal((agents.match(/kataster:begin/g) ?? []).length, 1, "no second managed block");
  assert.match(read(dir, "CLAUDE.md"), /kataster:claude:begin/);

  const ignore = read(dir, ".gitignore");
  assert.match(ignore, /^\.kataster\/$/m);
  assert.doesNotMatch(ignore, /laguardia/);

  assert.equal(json(dir, ".claude/install.json").tool, "kataster");
  assert.match(run(["doctor", dir]).out, /✓ No leftovers from the old name/);
});

test("detects a non-JavaScript stack and fills sensible commands", () => {
  const dir = repo({
    "go.mod": "module example.com/shop\n\ngo 1.24\n",
    "internal/orders/orders.go": "package orders\n",
  });
  const result = run(["init", dir, "--yes", "--no-install"]);
  assert.equal(result.code, 0, result.out);
  const profile = json(dir, ".claude/project.json");
  assert.equal(profile.kind, "brownfield");
  assert.deepEqual(profile.stack.languages, ["Go"]);
  assert.equal(profile.commands.test, "go test ./...");
  assert.equal(profile.commands.lint, "go vet ./...");
  assert.deepEqual(profile.repo.codeRoots, ["internal"]);
});

test("renders the UI language into the glossary and UX guidelines", () => {
  const dir = repo({ "package.json": "{}" });
  const result = run(["init", dir, "--yes", "--no-install", "--ui-language", "de", "--artifacts", "de"]);
  assert.equal(result.code, 0, result.out);
  assert.match(read(dir, "CONTEXT.md"), /_UI \(de\)_/);
  assert.match(read(dir, "docs/product/ux-guidelines.md"), /UI language: de/);
  assert.equal(json(dir, ".claude/project.json").languages.artifacts, "de");
});

test("configures a Jira backlog for the MCP adapter", () => {
  const dir = repo({ "package.json": "{}" });
  const result = run(["init", dir, "--yes", "--no-install", "--backlog", "jira", "--jira-project", "PROJ"]);
  assert.equal(result.code, 0, result.out);
  const backlog = json(dir, ".claude/project.json").backlog;
  assert.equal(backlog.provider, "jira");
  assert.equal(backlog.jira.project, "PROJ");
  assert.equal(backlog.jira.mcpServer, "mcp-atlassian");
  assert.equal(backlog.jira.statusMap["in-progress"], "In Progress");
  assert.equal(backlog.jira.priorityMap.must, "Highest");
});

test("configures a GitHub backlog", () => {
  const dir = repo({ "package.json": "{}" });
  const result = run(["init", dir, "--yes", "--no-install", "--backlog", "github", "--github-repo", "acme/demo"]);
  assert.equal(result.code, 0, result.out);
  const backlog = json(dir, ".claude/project.json").backlog;
  assert.equal(backlog.provider, "github");
  assert.equal(backlog.github.repo, "acme/demo");
});

test("rejects an unknown backlog backend", () => {
  const dir = repo({ "package.json": "{}" });
  const result = run(["init", dir, "--yes", "--no-install", "--backlog", "linear"]);
  assert.notEqual(result.code, 0);
  assert.match(result.out, /Unknown backlog backend 'linear'/);
});
