import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cli = resolve(here, "..", "bin", "kataster.mjs");
const toolNodeModules = resolve(here, "..", ".claude", "node_modules");

function repo(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), "kataster-intake-"));
  for (const [path, content] of Object.entries(files)) {
    const target = join(dir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
  }
  return dir;
}

function run(command, args, cwd, env = {}) {
  const r = spawnSync(command, args, { cwd, encoding: "utf8", env: { ...process.env, ...env } });
  return { code: r.status, out: `${r.stdout}${r.stderr}`, stdout: r.stdout };
}

const runIntake = (cwd, args, env = {}) =>
  run(
    process.execPath,
    [join(".claude", "skills", "feature", "scripts", "intake.ts"), ...args, "--json"],
    cwd,
    env,
  );

/** A `gh` stand-in: only `issue view` is needed – intake never writes. */
function fakeGh(dir) {
  const bin = join(dir, "fake-bin");
  mkdirSync(bin, { recursive: true });
  const file = join(bin, "gh");
  writeFileSync(file, `#!${process.execPath}
const fs = require("node:fs");
const state = JSON.parse(fs.readFileSync(process.env.FAKE_GH_STATE, "utf8"));
const args = process.argv.slice(2);
if (args[0] === "issue" && args[1] === "view") {
  const issue = state.issues.find((x) => x.number === Number(args[2]));
  if (!issue) { console.error("issue not found"); process.exit(1); }
  process.stdout.write(JSON.stringify(issue));
  process.exit(0);
}
console.error("fake gh: unsupported " + args.join(" "));
process.exit(1);
`, "utf8");
  chmodSync(file, 0o755);
  return bin;
}

const readyStory = `---
id: ST-001
title: Place an order
type: story
context: BC-Order
priority: must
size: M
risk: low
events: [EVT-OrderPlaced]
depends_on: []
labels: [mvp]
status: ready
external:
  provider: github
  key: "7"
  url: https://github.com/acme/demo/issues/7
---

## Story
As a customer, I want to place an order, so that I get the goods.

## Acceptance Criteria

Scenario: Order is placed
  Given a valid cart
  When the order is placed
  Then it is recorded

Scenario: Empty cart
  Given an empty cart
  When the order is placed
  Then it is rejected
`;

const draftStory = readyStory
  .replace("id: ST-001", "id: ST-002")
  .replace("title: Place an order", "title: Attach photos")
  .replace("status: ready", "status: draft")
  .replace(/\nexternal:\n(?:  .*\n)+/, "\n");

function jiraFile(dir) {
  const file = join(dir, "jira-issues.json");
  writeFileSync(file, JSON.stringify([
    {
      key: "PROJ-1",
      fields: {
        summary: "Customers attach photos to orders",
        description: "As a customer I want to attach photos.\n\nScenario: Photo is attached",
        status: { name: "To Do" },
        issuetype: { name: "Story" },
        labels: [],
      },
    },
    {
      key: "PROJ-2",
      fields: {
        summary: "Totals are wrong",
        description: "The total ignores the discount.",
        status: { name: "In Progress" },
        issuetype: { name: "Bug" },
        labels: [],
      },
    },
    {
      // A Jira project may use the same prefix as the local story ids.
      key: "ST-123",
      fields: {
        summary: "Support ticket from Jira",
        description: "Reported by a customer.",
        status: { name: "To Do" },
        issuetype: { name: "Story" },
        labels: [],
      },
    },
  ]), "utf8");
  return file;
}

function fixture() {
  const dir = repo({
    "package.json": "{}",
    "docs/stories/ST-001-place-an-order.md": readyStory,
    "docs/stories/ST-002-attach-photos.md": draftStory,
  });
  const init = run(process.execPath, [cli, "init", dir, "--yes", "--no-install", "--backlog", "github", "--github-repo", "acme/demo"], process.cwd());
  assert.equal(init.code, 0, init.out);
  symlinkSync(toolNodeModules, join(dir, ".claude", "node_modules"), "dir");
  writeFileSync(join(dir, "gh-state.json"), JSON.stringify({
    issues: [
      { number: 7, title: "ST-001: Place an order", body: "Place an order.", state: "OPEN", labels: [], url: "https://github.com/acme/demo/issues/7" },
      { number: 8, title: "Fix totals in checkout", body: "Scenario: Discount is included", state: "OPEN", labels: [{ name: "bug" }], url: "https://github.com/acme/demo/issues/8" },
      { number: 9, title: "Customers attach photos", body: "Photos on orders.", state: "OPEN", labels: [{ name: "feature" }], url: "https://github.com/acme/demo/issues/9" },
      { number: 10, title: "Old request", body: "Closed long ago.", state: "CLOSED", labels: [], url: "https://github.com/acme/demo/issues/10" },
    ],
  }), "utf8");
  const env = { PATH: `${fakeGh(dir)}:${process.env.PATH}`, FAKE_GH_STATE: join(dir, "gh-state.json") };
  return { dir, env };
}

const json = (result) => JSON.parse(result.stdout);

test("a linked GitHub issue routes to the existing story", () => {
  const { dir, env } = fixture();
  const result = runIntake(dir, ["#7"], env);
  assert.equal(result.code, 0, result.out);
  const data = json(result);
  assert.equal(data.source.kind, "github");
  assert.equal(data.source.ref, "#7");
  assert.equal(data.route, "implement-story");
  assert.equal(data.story.id, "ST-001");
  assert.match(data.warnings.join("\n"), /linked to ST-001/);
});

test("a local story id routes by status", () => {
  const { dir, env } = fixture();
  const draft = json(runIntake(dir, ["ST-002"], env));
  assert.equal(draft.source.kind, "story");
  assert.equal(draft.route, "continue-story");
  assert.equal(draft.story.id, "ST-002");

  const ready = json(runIntake(dir, ["ST-001"], env));
  assert.equal(ready.route, "implement-story");
});

test("a bug issue routes to the bug path with its signals", () => {
  const { dir, env } = fixture();
  const data = json(runIntake(dir, ["#8"], env));
  assert.equal(data.route, "bug");
  assert.equal(data.signals.bug, true);
  assert.equal(data.signals.scenarios, 1);
  assert.equal(data.story, null);
});

test("a normal issue routes to the feature pipeline", () => {
  const { dir, env } = fixture();
  const data = json(runIntake(dir, ["#9"], env));
  assert.equal(data.route, "feature");
  assert.equal(data.signals.bug, false);
});

test("a closed issue is still readable and warns", () => {
  const { dir, env } = fixture();
  const data = json(runIntake(dir, ["#10"], env));
  assert.equal(data.route, "feature");
  assert.match(data.warnings.join("\n"), /closed/);
});

test("a missing story fails with exit code 2", () => {
  const { dir, env } = fixture();
  const result = runIntake(dir, ["ST-999"], env);
  assert.equal(result.code, 2);
  assert.match(result.out, /ST-999 not found/);
});

test("Jira issues come from the MCP export and keep the issue type", () => {
  const { dir, env } = fixture();
  const from = jiraFile(dir);

  const story = json(runIntake(dir, ["PROJ-1", "--from", from], env));
  assert.equal(story.source.kind, "jira");
  assert.equal(story.source.ref, "PROJ-1");
  assert.equal(story.route, "feature");
  assert.equal(story.signals.scenarios, 1);

  const bug = json(runIntake(dir, ["PROJ-2", "--from", from], env));
  assert.equal(bug.route, "bug");
  assert.equal(bug.signals.bug, true);
});

test("a Jira project with the ST prefix is disambiguated by the export", () => {
  const { dir, env } = fixture();
  const from = jiraFile(dir);
  const data = json(runIntake(dir, ["ST-123", "--from", from], env));
  assert.equal(data.source.kind, "jira");
  assert.equal(data.source.ref, "ST-123");
  assert.equal(data.route, "feature");
});

test("Jira without the MCP export explains the two-step flow", () => {
  const { dir, env } = fixture();
  const result = runIntake(dir, ["PROJ-1"], env);
  assert.equal(result.code, 2);
  assert.match(result.out, /mcp-atlassian/);
  assert.match(result.out, /--from/);
});

test("free text still routes to the feature pipeline", () => {
  const { dir, env } = fixture();
  const data = json(runIntake(dir, ["customers attach photos to orders"], env));
  assert.equal(data.source.kind, "text");
  assert.equal(data.route, "feature");
});

test("intake writes nothing", () => {
  const { dir, env } = fixture();
  const before = readFileSync(join(dir, "docs/stories/ST-001-place-an-order.md"), "utf8");
  runIntake(dir, ["#7"], env);
  assert.equal(readFileSync(join(dir, "docs/stories/ST-001-place-an-order.md"), "utf8"), before);
  assert.ok(!existsSync(join(dir, ".kataster")), "intake must not create a backup or sync state");
});
