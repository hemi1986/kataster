import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cli = resolve(here, "..", "bin", "kataster.mjs");
const toolNodeModules = resolve(here, "..", ".claude", "node_modules");

function repo(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), "kataster-sync-"));
  for (const [path, content] of Object.entries(files)) {
    const target = join(dir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
  }
  return dir;
}

function run(command, args, cwd, env = {}) {
  const r = spawnSync(command, args, { cwd, encoding: "utf8", env: { ...process.env, ...env } });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

function runNode(cwd, script, env = {}) {
  return run(process.execPath, [join(".claude", "skills", "backlog", "scripts", script)], cwd, env);
}

const read = (dir, path) => readFileSync(join(dir, path), "utf8");

/** A small `gh` stand-in: issues, labels and the five commands the sync uses. */
function fakeGh(dir) {
  const bin = join(dir, "fake-bin");
  mkdirSync(bin, { recursive: true });
  const file = join(bin, "gh");
  writeFileSync(file, `#!${process.execPath}
const fs = require("node:fs");
const stateFile = process.env.FAKE_GH_STATE;
const load = () => { try { return JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch { return { next: 1, labels: [], issues: [] }; } };
const save = (s) => fs.writeFileSync(stateFile, JSON.stringify(s, null, 2));
const args = process.argv.slice(2);
const s = load();
const take = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const takes = (name) => { const out = []; args.forEach((a, i) => { if (a === name) out.push(args[i + 1]); }); return out; };
const out = (v) => { process.stdout.write(JSON.stringify(v)); process.exit(0); };
const cmd = args[0] + " " + args[1];
if (cmd === "label list") out(s.labels.map((name) => ({ name })));
if (cmd === "label create") { const name = args[2]; if (!s.labels.includes(name)) s.labels.push(name); save(s); process.exit(0); }
if (cmd === "issue list") out(s.issues);
if (cmd === "issue view") { const i = s.issues.find((x) => x.number === Number(args[2])); if (!i) process.exit(1); out(i); }
if (cmd === "issue create") {
  const n = s.next++;
  const issue = { number: n, title: take("--title"), body: fs.readFileSync(0, "utf8"), state: "OPEN",
    labels: takes("--label").map((name) => ({ name })), url: "https://github.com/acme/demo/issues/" + n };
  s.issues.push(issue); save(s); process.stdout.write(issue.url + "\\n"); process.exit(0);
}
if (cmd === "issue edit") {
  const i = s.issues.find((x) => x.number === Number(args[2])); if (!i) process.exit(1);
  if (args.includes("--title")) i.title = take("--title");
  if (args.includes("--body-file")) i.body = fs.readFileSync(0, "utf8");
  for (const l of takes("--add-label")) if (!i.labels.some((x) => x.name === l)) i.labels.push({ name: l });
  for (const l of takes("--remove-label")) i.labels = i.labels.filter((x) => x.name !== l);
  save(s); process.exit(0);
}
if (cmd === "issue close") { const i = s.issues.find((x) => x.number === Number(args[2])); if (i) i.state = "CLOSED"; save(s); process.exit(0); }
if (cmd === "issue reopen") { const i = s.issues.find((x) => x.number === Number(args[2])); if (i) i.state = "OPEN"; save(s); process.exit(0); }
console.error("fake gh: unsupported " + args.join(" ")); process.exit(1);
`, "utf8");
  chmodSync(file, 0o755);
  return bin;
}

const story = `---
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
status: draft
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

const events = `version: 1
domain: demo
bounded_contexts:
  - id: BC-Order
    name: Order
    purpose: Taking orders.
events:
  - id: EVT-OrderPlaced
    name: Order placed
    context: BC-Order
`;

function githubRepo() {
  const dir = repo({
    "package.json": "{}",
    "docs/domain/events.yaml": events,
    "docs/stories/ST-001-place-an-order.md": story,
  });
  const init = run(process.execPath, [cli, "init", dir, "--yes", "--no-install", "--backlog", "github", "--github-repo", "acme/demo"], process.cwd());
  assert.equal(init.code, 0, init.out);
  symlinkSync(toolNodeModules, join(dir, ".claude", "node_modules"), "dir");
  const env = { PATH: `${fakeGh(dir)}:${process.env.PATH}`, FAKE_GH_STATE: join(dir, "gh-state.json") };
  return { dir, env };
}

test("GitHub sync creates, updates and pulls a story", () => {
  const { dir, env } = githubRepo();

  const push = runNode(dir, "backlog-push.ts", env);
  assert.equal(push.code, 0, push.out);
  assert.match(push.out, /created\s+ST-001 → #1/);
  assert.match(read(dir, "docs/stories/ST-001-place-an-order.md"), /external:\n  provider: github\n  key: "1"/);

  const status = runNode(dir, "backlog-status.ts", env);
  assert.equal(status.code, 0, status.out);
  assert.match(status.out, /synced\s+ST-001 ↔ #1/);

  // Remote changed: the pull brings the tracker's title and status label into the mirror.
  const stateFile = join(dir, "gh-state.json");
  const state = JSON.parse(readFileSync(stateFile, "utf8"));
  state.issues[0].title = "ST-001: Place an order (remote)";
  state.issues[0].labels = state.issues[0].labels.filter((label) => !label.name.startsWith("kataster-status-"));
  state.issues[0].labels.push({ name: "kataster-status-ready" });
  writeFileSync(stateFile, JSON.stringify(state, null, 2));

  const pull = runNode(dir, "backlog-pull.ts", env);
  assert.equal(pull.code, 0, pull.out);
  assert.match(pull.out, /updated\s+ST-001 ← #1/);
  const mirrored = read(dir, "docs/stories/ST-001-place-an-order.md");
  assert.match(mirrored, /title: Place an order \(remote\)/);
  assert.match(mirrored, /status: ready/);
});

test("push removes a label that was removed locally", () => {
  const { dir, env } = githubRepo();
  assert.equal(runNode(dir, "backlog-push.ts", env).code, 0);

  const file = join(dir, "docs/stories/ST-001-place-an-order.md");
  writeFileSync(file, read(dir, "docs/stories/ST-001-place-an-order.md").replace("labels: [mvp]", "labels: [other]"), "utf8");
  const push = runNode(dir, "backlog-push.ts", env);
  assert.equal(push.code, 0, push.out);
  const state = JSON.parse(readFileSync(join(dir, "gh-state.json"), "utf8"));
  const labels = state.issues[0].labels.map((label) => label.name);
  assert.ok(labels.includes("other"), `missing 'other' in ${labels.join(", ")}`);
  assert.ok(!labels.includes("mvp"), `stale 'mvp' in ${labels.join(", ")}`);
});

test("a fresh clone rebuilds the sync state without a conflict", () => {
  const { dir, env } = githubRepo();
  assert.equal(runNode(dir, "backlog-push.ts", env).code, 0);
  rmSync(join(dir, ".claude", "state", "backlog-sync.json"));
  const pull = runNode(dir, "backlog-pull.ts", env);
  assert.equal(pull.code, 0, pull.out);
  assert.match(pull.out, /state rebuilt/);
  assert.ok(!existsSync(join(dir, ".kataster", "backup", "backlog")), "unexpected backup");
});

test("a conflict backs up the local story and lets the tracker win", () => {  const { dir, env } = githubRepo();
  assert.equal(runNode(dir, "backlog-push.ts", env).code, 0);

  const stateFile = join(dir, "gh-state.json");
  const state = JSON.parse(readFileSync(stateFile, "utf8"));
  state.issues[0].title = "ST-001: Remote title";
  writeFileSync(stateFile, JSON.stringify(state, null, 2));

  const localFile = join(dir, "docs/stories/ST-001-place-an-order.md");
  writeFileSync(localFile, read(dir, "docs/stories/ST-001-place-an-order.md").replace("title: Place an order", "title: Local title"), "utf8");

  const pull = runNode(dir, "backlog-pull.ts", env);
  assert.equal(pull.code, 0, pull.out);
  assert.match(pull.out, /conflict\s+ST-001/);
  assert.match(read(dir, "docs/stories/ST-001-place-an-order.md"), /title: Remote title/);
  assert.ok(existsSync(join(dir, ".kataster", "backup", "backlog")), "backup directory missing");
});
