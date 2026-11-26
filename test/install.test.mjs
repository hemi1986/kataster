import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { ALLOW, OPENCODE_ALLOW, PKG } from "../src/install.mjs";
import { isOwnRule } from "../src/permissions.mjs";
import { parseJsonc, sha } from "../src/util.mjs";
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
    ".claude/skills/user-stories/scripts/lint-story.ts",
    ".claude/skills/feature/scripts/intake.ts",
    ".claude/skills/shape/SKILL.md",
    ".claude/skills/prototype/SKILL.md",
    ".claude/skills/prototype/UI.md",
    ".claude/skills/prototype/LOGIC.md",
    ".claude/skills/research/SKILL.md",
    ".claude/skills/research/templates/research.md",
    ".claude/skills/research/scripts/research-check.ts",
    ".claude/agents/researcher.md",
    ".opencode/agents/researcher.md",
    ".opencode/commands/research.md",
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
    ".claude/skills/marathon/SKILL.md",
    ".claude/skills/marathon/scripts/marathon-state.ts",
    ".claude/lib/marathon.ts",
    ".opencode/commands/marathon.md",
    ".opencode/plugins/kataster/index.ts",
    "AGENTS.md",
    "CLAUDE.md",
    "CONTEXT.md",
    "docs/workflow.md",
    "docs/domain/events.yaml",
    "docs/product/vision.md",
    "docs/product/initiatives/README.md",
    "docs/prototypes/README.md",
    "docs/engineering/conventions.md",
    "docs/research/README.md",
    "docs/stories/README.md",
  ]) {
    assert.ok(existsSync(join(dir, file)), `${file} missing`);
  }
  for (const removed of ["product-owner", "requirements-engineer", "lead-dev"]) {
    assert.ok(!existsSync(join(dir, ".claude", "agents", `${removed}.md`)), `${removed} agent must not be installed`);
    assert.ok(!existsSync(join(dir, ".opencode", "agents", `${removed}.md`)), `${removed} agent must not be installed`);
  }

  const profile = json(dir, ".claude/project.json");
  assert.equal(profile.kind, "brownfield");
  assert.equal(profile.name, "demo");
  assert.deepEqual(profile.stack.frameworks, ["Next.js"]);
  assert.deepEqual(profile.stack.databases, ["PostgreSQL"]);
  assert.equal(profile.commands.lint, "npm run lint");
  assert.equal(profile.backlog.provider, "local");
  assert.equal(profile.research.expiryMonths, 12);
  assert.deepEqual(profile.research.gate.risk, ["high"]);
  assert.deepEqual(profile.research.gate.labels, ["security", "auth", "payment", "privacy"]);

  assert.match(read(dir, "CONTEXT.md"), /^# demo/m);
  assert.match(read(dir, "docs/domain/events.yaml"), /domain: demo/);
  assert.match(read(dir, "AGENTS.md"), /kataster:begin/);
  assert.match(read(dir, "AGENTS.md"), /read-only `researcher`/);
  assert.match(read(dir, "AGENTS.md"), /installed templates are English and are translated as you fill them/);

  const settings = json(dir, ".claude/settings.json");
  assert.ok(settings.hooks.SessionStart[0].hooks[0].command.includes("session-start.ts"));
  assert.ok(settings.permissions.allow.some((a) => a.includes("validate-events.ts")));
  assert.ok(settings.permissions.allow.includes("Bash(node .claude/skills/research/scripts/*)"));

  const manifest = json(dir, ".claude/install.json");
  assert.equal(manifest.tool, "kataster");
  assert.ok(Object.keys(manifest.files).length > 50);
  assert.ok(!(".claude/project.json" in manifest.files), "project content is not managed");
});

test("OpenCode mirrors every Claude Code allow rule", () => {
  assert.equal(OPENCODE_ALLOW.length, ALLOW.length, "every ALLOW entry needs an OpenCode rule");
  for (const rule of OPENCODE_ALLOW) assert.deepEqual(Object.keys(rule), ["action", "resource", "effect"]);
  assert.ok(OPENCODE_ALLOW.some((r) => r.action === "shell" && r.resource === "git status *" && r.effect === "allow"));
  // The shipped template carries the same rules, so a fresh install and an upgrade end up alike.
  const template = parseJsonc(readFileSync(join(PKG, ".opencode", "opencode.jsonc"), "utf8"));
  assert.deepEqual(template.permissions, OPENCODE_ALLOW);
  assert.equal(template.automations, false, "OpenCode automations are off by default");

  const dir = repo({ "package.json": "{}" });
  assert.equal(run(["init", dir, "--yes", "--no-install"]).code, 0);
  assert.deepEqual(parseJsonc(read(dir, ".opencode/opencode.jsonc")).permissions, OPENCODE_ALLOW);
  assert.equal(parseJsonc(read(dir, ".opencode/opencode.jsonc")).automations, false);
  assert.deepEqual(json(dir, ".claude/settings.json").permissions.allow, ALLOW);
});

test("merges the OpenCode rules into an existing config: the project's own first, ours once", () => {
  const own = { action: "shell", resource: "*", effect: "ask" };
  // Same rule as ours, other key order – not added twice.
  const dup = { effect: "allow", resource: "git diff *", action: "shell" };
  const dir = repo({
    "package.json": "{}",
    ".opencode/opencode.jsonc": `// ours\n${JSON.stringify({ model: "x/y", permissions: [own, dup] })}`,
  });
  assert.equal(run(["init", dir, "--yes", "--no-install"]).code, 0);
  const config = parseJsonc(read(dir, ".opencode/opencode.jsonc"));
  assert.equal(config.model, "x/y");
  // A catch-all `ask`: only Kataster's own scripts go after it, everything else in front of it, where the `ask` wins.
  const missing = OPENCODE_ALLOW.filter((r) => r.resource !== "git diff *");
  assert.deepEqual(config.permissions, [...missing.filter((r) => !isOwnRule(r)), own, dup, ...missing.filter(isOwnRule)]);

  // An installation from before the mirror has no rules at all: an upgrade adds every one.
  const old = repo({ "package.json": "{}", ".opencode/opencode.jsonc": JSON.stringify({ watcher: { ignore: ["tmp/**"] } }) });
  assert.equal(run(["init", old, "--yes", "--no-install"]).code, 0);
  const upgraded = parseJsonc(read(old, ".opencode/opencode.jsonc"));
  assert.deepEqual(upgraded.permissions, OPENCODE_ALLOW);
  assert.equal(upgraded.automations, false, "an upgrade turns automations off where the project said nothing");
  assert.ok(upgraded.watcher.ignore.includes("tmp/**"));

  // A project that wants automations keeps them.
  const wants = repo({ "package.json": "{}", ".opencode/opencode.jsonc": JSON.stringify({ automations: true }) });
  assert.equal(run(["init", wants, "--yes", "--no-install"]).code, 0);
  assert.equal(parseJsonc(read(wants, ".opencode/opencode.jsonc")).automations, true);

  // Something other than a rule list is the project's business.
  const odd = repo({ "package.json": "{}", ".opencode/opencode.jsonc": JSON.stringify({ permissions: { shell: "ask" } }) });
  assert.equal(run(["init", odd, "--yes", "--no-install"]).code, 0);
  assert.deepEqual(parseJsonc(read(odd, ".opencode/opencode.jsonc")).permissions, { shell: "ask" });
});

test("an upgrade edits a commented opencode.jsonc in place: comments and formatting stay", () => {
  const own = `{
  // Our model – pinned, see ADR 0007.
  "model": "x/y",

  /* Shell stays behind a prompt here. */
  "permissions": [
    { "action": "shell", "resource": "*", "effect": "ask" }, // catch-all
  ],
  "watcher": {
    "ignore": ["tmp/**"] // scratch output
  }
}
`;
  const dir = repo({ "package.json": "{}", ".opencode/opencode.jsonc": own });
  assert.equal(run(["init", dir, "--yes", "--no-install"]).code, 0);
  const text = read(dir, ".opencode/opencode.jsonc");
  for (const comment of ["// Our model – pinned, see ADR 0007.", "/* Shell stays behind a prompt here. */", "// catch-all", "// scratch output"]) {
    assert.ok(text.includes(comment), `comment kept: ${comment}`);
  }
  assert.ok(text.startsWith('{\n  // Our model – pinned, see ADR 0007.\n  "model": "x/y",\n\n  /* Shell'), text);
  const config = parseJsonc(text);
  assert.equal(config.automations, false);
  assert.deepEqual(config.permissions, [
    ...OPENCODE_ALLOW.filter((r) => !isOwnRule(r)),
    { action: "shell", resource: "*", effect: "ask" },
    ...OPENCODE_ALLOW.filter(isOwnRule),
  ]);
  assert.ok(config.watcher.ignore.includes("tmp/**") && config.watcher.ignore.includes("**/node_modules/**"));
  // Our rules are written in the style of the project's own: one rule per line.
  assert.match(text, /\n {4}\{ "action": "shell", "resource": "git status \*", "effect": "allow" \},?\n/);
  // The comment in front of the project's catch-all stays with it: ours are inserted above the comment's rule.
  assert.match(text, /"git log \*", "effect": "allow" \},\n {4}\{ "action": "shell", "resource": "\*", "effect": "ask" \}, \/\/ catch-all\n/);

  // A second upgrade has nothing to add and leaves the file byte for byte.
  assert.equal(run(["init", dir, "--yes", "--no-install"]).code, 0);
  assert.equal(read(dir, ".opencode/opencode.jsonc"), text);

  // The shipped template is commented too: an upgrade of a fresh install keeps it as it is.
  const fresh = repo({ "package.json": "{}" });
  assert.equal(run(["init", fresh, "--yes", "--no-install"]).code, 0);
  assert.equal(run(["init", fresh, "--yes", "--no-install"]).code, 0);
  assert.equal(read(fresh, ".opencode/opencode.jsonc"), readFileSync(join(PKG, ".opencode", "opencode.jsonc"), "utf8"));
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

test("init says when --greenfield overrides the detection", () => {
  const dir = repo({ "package.json": "{}", "src/app.ts": "export const app = 1;\n" });
  const result = run(["init", dir, "--yes", "--no-install", "--greenfield"]);
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /Using: greenfield \(--greenfield overrides the detection\)/);
  assert.equal(json(dir, ".claude/project.json").kind, "greenfield");
});

test("init prints the ignore entries the app's tools need, and doctor only warns", () => {
  const dir = repo({ "package.json": "{}", ".prettierrc": "{}", "eslint.config.js": "export default [];\n" });
  const init = run(["init", dir, "--yes", "--no-install"]);
  assert.equal(init.code, 0, init.out);
  assert.match(init.out, /also checks Kataster's own files/);
  assert.match(init.out, /ESLint – eslint\.config\.js:\n\s+\{ ignores: \[".claude\/\*\*", ".opencode\/\*\*"\] \}/);
  assert.equal(read(dir, "eslint.config.js"), "export default [];\n", "init must not touch the config");
  const doctor = run(["doctor", dir]).out;
  assert.match(doctor, /! ESLint ignores Kataster's files/);
  assert.match(doctor, /warning\(s\)/);
  assert.doesNotMatch(doctor, /✗ (ESLint|Prettier)/);
});

test("doctor flags ADRs whose status is not in the frontmatter", () => {
  const dir = repo({
    "package.json": "{}",
    "docs/adr/0001-use-events.md": "---\nstatus: accepted\n---\n\n# Use events\n",
    "docs/adr/0002-use-postgres.md": "# Use Postgres\n\n- **Status:** Accepted\n",
  });
  assert.equal(run(["init", dir, "--yes", "--no-install"]).code, 0);
  const out = run(["doctor", dir]).out;
  assert.match(out, /✗ ADR status in frontmatter\s+\(docs\/adr\/0002-use-postgres\.md –/);
  assert.doesNotMatch(out, /0001-use-events/);
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

test("no longer installs extras and rejects the removed --with flag", () => {
  const dir = repo({ "package.json": "{}" });
  const rejected = run(["--with", "shadcn", "init", dir, "--yes"]);
  assert.notEqual(rejected.code, 0);
  assert.match(rejected.out, /--with was removed/);
  // The value after --with must not be read as the target directory.
  assert.equal(existsSync(join(dir, ".claude")), false);

  const installed = run(["init", dir, "--yes", "--no-install"]);
  assert.equal(installed.code, 0, installed.out);
  assert.equal(existsSync(join(dir, ".claude", "skills", "shadcn")), false);
});

test("upgrade drops an extras field left in the profile", () => {
  const dir = repo({ "package.json": "{}" });
  assert.equal(run(["init", dir, "--yes", "--no-install"]).code, 0);
  const profilePath = join(dir, ".claude", "project.json");
  const profile = JSON.parse(readFileSync(profilePath, "utf8"));
  profile.workflow.extras = ["shadcn"];
  writeFileSync(profilePath, JSON.stringify(profile, null, 2), "utf8");

  const upgraded = run(["upgrade", dir, "--no-install"]);
  assert.equal(upgraded.code, 0, upgraded.out);
  assert.equal(json(dir, ".claude/project.json").workflow.extras, undefined);
});

test("installs the third-party notices with the payload", () => {
  const dir = repo({ "package.json": "{}" });
  assert.equal(run(["init", dir, "--yes", "--no-install"]).code, 0);
  const notices = read(dir, ".claude/THIRD_PARTY_NOTICES.md");
  assert.match(notices, /Matt Pocock/);
  assert.match(notices, /MIT License/);
  assert.match(notices, /skills\/prototype\/SKILL\.md/);
});

test("upgrade prunes the retired agent files", () => {
  const dir = repo({ "package.json": "{}" });
  assert.equal(run(["init", dir, "--yes", "--no-install"]).code, 0);

  const manifestPath = join(dir, ".claude", "install.json");
  const obsolete = "---\nname: product-owner\n---\n\nRemoved from the workflow.\n";
  const custom = "---\nname: lead-dev\n---\n\nLocally changed.\n";
  writeFileSync(join(dir, ".claude/agents/product-owner.md"), obsolete, "utf8");
  writeFileSync(join(dir, ".claude/agents/lead-dev.md"), custom, "utf8");

  const manifest = json(dir, ".claude/install.json");
  manifest.files[".claude/agents/product-owner.md"] = sha(obsolete);
  manifest.files[".claude/agents/lead-dev.md"] = sha("---\nname: lead-dev\n---\n\nOriginal.\n");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

  const result = run(["upgrade", dir, "--yes", "--no-install"]);
  assert.equal(result.code, 0, result.out);

  assert.ok(!existsSync(join(dir, ".claude/agents/product-owner.md")), "unmodified retired file is removed");
  assert.ok(existsSync(join(dir, ".claude/agents/lead-dev.md")), "locally modified retired file is kept");
  assert.match(result.out, /locally modified/);
  assert.ok(!(".claude/agents/product-owner.md" in json(dir, ".claude/install.json").files), "pruned file leaves the manifest");
  assert.ok(".claude/agents/lead-dev.md" in json(dir, ".claude/install.json").files, "kept file stays tracked");
});

test("upgrade keeps files the project deleted, and --restore brings them back", () => {
  const dir = repo({ "package.json": "{}" });
  assert.equal(run(["init", dir, "--yes", "--no-install"]).code, 0);

  const removed = ["docs/research/README.md", "docs/stories/README.md", ".claude/package-lock.json"];
  for (const file of removed) rmSync(join(dir, file));

  for (let i = 0; i < 2; i += 1) {
    const upgrade = run(["upgrade", dir, "--no-install"]);
    assert.equal(upgrade.code, 0, upgrade.out);
    assert.match(upgrade.out, /3 file\(s\) not re-created because the project deleted them/);
    for (const file of removed) assert.ok(!existsSync(join(dir, file)), `${file} must stay deleted`);
  }
  const manifest = json(dir, ".claude/install.json");
  assert.deepEqual(manifest.deleted, [".claude/package-lock.json", "docs/research/README.md", "docs/stories/README.md"]);
  assert.ok(!(".claude/package-lock.json" in manifest.files), "a deleted file is no longer tracked");
  assert.ok(manifest.seeded.includes("docs/prototypes/README.md"));

  const doctor = run(["doctor", dir]);
  assert.match(doctor.out, /✓ Deleted workflow files still referenced\s+\(3 deleted on purpose, none referenced\)/);

  const restore = run(["upgrade", dir, "--no-install", "--restore"]);
  assert.equal(restore.code, 0, restore.out);
  for (const file of removed) assert.ok(existsSync(join(dir, file)), `${file} restored`);
  assert.deepEqual(json(dir, ".claude/install.json").deleted, []);
});

test("an installation from before 0.6.3 counts a missing skeleton file as deleted", () => {
  const dir = repo({ "package.json": "{}" });
  assert.equal(run(["init", dir, "--yes", "--no-install"]).code, 0);
  const manifestPath = join(dir, ".claude", "install.json");
  const manifest = json(dir, ".claude/install.json");
  delete manifest.seeded;
  delete manifest.deleted;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  rmSync(join(dir, "docs/product/initiatives/README.md"));

  const upgrade = run(["upgrade", dir, "--no-install"]);
  assert.equal(upgrade.code, 0, upgrade.out);
  assert.ok(!existsSync(join(dir, "docs/product/initiatives/README.md")));
  assert.deepEqual(json(dir, ".claude/install.json").deleted, ["docs/product/initiatives/README.md"]);
});

test("a deleted file the project creates again is its own and is not overwritten", () => {
  const dir = repo({ "package.json": "{}" });
  assert.equal(run(["init", dir, "--yes", "--no-install"]).code, 0);
  const skill = join(dir, ".claude/skills/grilling/SKILL.md");
  rmSync(skill);
  assert.equal(run(["upgrade", dir, "--no-install"]).code, 0);
  writeFileSync(skill, "# Our own grilling\n", "utf8");

  const upgrade = run(["upgrade", dir, "--no-install"]);
  assert.equal(upgrade.code, 0, upgrade.out);
  assert.match(upgrade.out, /conflict\s+\.claude\/skills\/grilling\/SKILL\.md/);
  assert.equal(readFileSync(skill, "utf8"), "# Our own grilling\n");
});

test("doctor fails when a deleted workflow file is still referenced", () => {
  const dir = repo({ "package.json": "{}" });
  assert.equal(run(["init", dir, "--yes", "--no-install"]).code, 0);
  rmSync(join(dir, ".claude/hooks/session-start.ts"));
  assert.equal(run(["upgrade", dir, "--no-install"]).code, 0);
  assert.ok(!existsSync(join(dir, ".claude/hooks/session-start.ts")));

  const doctor = run(["doctor", dir]);
  assert.equal(doctor.code, 1);
  assert.match(doctor.out, /✗ Deleted workflow files still referenced\s+\(\.claude\/hooks\/session-start\.ts \(used by [^)]*\.claude\/settings\.json/);
});
