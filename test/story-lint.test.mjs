import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cli = resolve(here, "..", "bin", "kataster.mjs");
const yamlSource = resolve(here, "..", ".claude", "node_modules", "yaml");

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "kataster-spec-"));
  writeFileSync(join(dir, "package.json"), "{}", "utf8");
  const result = spawnSync(process.execPath, [cli, "init", dir, "--yes", "--no-install"], { cwd: dir, encoding: "utf8" });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  // The scripts need the `yaml` runtime dependency; the installer normally runs `npm install --prefix .claude`.
  mkdirSync(join(dir, ".claude", "node_modules"), { recursive: true });
  cpSync(yamlSource, join(dir, ".claude", "node_modules", "yaml"), { recursive: true });
  return dir;
}

function write(dir, path, content) {
  const target = join(dir, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, "utf8");
}

function node(dir, script, args = []) {
  const r = spawnSync(process.execPath, [join(dir, ".claude", "skills", script), ...args], { cwd: dir, encoding: "utf8" });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const lint = (dir, args = []) => node(dir, "user-stories/scripts/lint-story.ts", args);
const status = (dir, id, to) => node(dir, "implement/scripts/story-status.ts", [id, to]);

const events = `version: 1
domain: demo
actors:
  - id: ACT-Customer
    name: Customer
bounded_contexts:
  - id: BC-Order
    name: Order
    purpose: Taking orders.
  - id: BC-Billing
    name: Billing
    purpose: Invoices.
aggregates:
  - id: AGG-Order
    name: Order
    context: BC-Order
  - id: AGG-Invoice
    name: Invoice
    context: BC-Billing
events:
  - id: EVT-OrderPlaced
    name: Order placed
    aggregate: AGG-Order
  - id: EVT-InvoiceIssued
    name: Invoice issued
    aggregate: AGG-Invoice
commands:
  - id: CMD-PlaceOrder
    name: Place order
    actor: ACT-Customer
    aggregate: AGG-Order
    produces: [EVT-OrderPlaced]
  - id: CMD-IssueInvoice
    name: Issue invoice
    aggregate: AGG-Invoice
    produces: [EVT-InvoiceIssued]
`;

const scenarios = (n) =>
  Array.from({ length: n }, (_, i) => `Scenario: Case ${i + 1}\n  Given a cart\n  When the order is placed\n  Then it is recorded\n`).join("\n");

function story(body, extra = "") {
  return `---
id: ST-001
title: Place an order
type: domain
context: BC-Order
aggregate: AGG-Order
command: CMD-PlaceOrder
priority: should
events: [EVT-OrderPlaced]
depends_on: []
status: review
${extra}---

## Story
As a customer, I want to place an order, so that I get the goods.

## Context
A valid cart.

## Acceptance Criteria

${body}
`;
}

function setup(storyText) {
  const dir = repo();
  write(dir, "docs/domain/events.yaml", events);
  write(dir, "docs/stories/ST-001-place-order.md", storyText);
  return dir;
}

test("a domain story with one command and two scenarios passes the spec linter", () => {
  const dir = setup(story(scenarios(2)));
  const result = lint(dir, ["ST-001"]);
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /Spec linter OK/);
});

test("domain stories must name exactly one aggregate and command", () => {
  const dir = setup(story(scenarios(2)).replace("aggregate: AGG-Order\ncommand: CMD-PlaceOrder\n", ""));
  const result = lint(dir, ["ST-001"]);
  assert.equal(result.code, 1);
  assert.match(result.out, /needs exactly one aggregate/);
  assert.match(result.out, /needs exactly one command/);
});

test("the command must belong to the stated aggregate and its events must match", () => {
  const dir = setup(
    story(scenarios(2))
      .replace("aggregate: AGG-Order", "aggregate: AGG-Invoice")
      .replace("events: [EVT-OrderPlaced]", "events: [EVT-InvoiceIssued]"),
  );
  const result = lint(dir, ["ST-001"]);
  assert.equal(result.code, 1);
  assert.match(result.out, /belongs to aggregate 'AGG-Order', not 'AGG-Invoice'/);
});

test("linked events must be exactly what the command produces", () => {
  const dir = setup(story(scenarios(2)).replace("events: [EVT-OrderPlaced]", "events: [EVT-InvoiceIssued]"));
  const result = lint(dir, ["ST-001"]);
  assert.equal(result.code, 1);
  assert.match(result.out, /events must be exactly what command 'CMD-PlaceOrder' produces/);
});

test("at most four scenarios per domain story", () => {
  const dir = setup(story(scenarios(5)));
  const result = lint(dir, ["ST-001"]);
  assert.equal(result.code, 1);
  assert.match(result.out, /at most 4/);
});

test("every Gherkin scenario needs Given, When and Then", () => {
  const dir = setup(story("Scenario: Missing given\n  When the order is placed\n  Then it is recorded\n\nScenario: Missing then\n  Given a cart\n  When the order is placed\n"));
  const result = lint(dir, ["ST-001"]);
  assert.equal(result.code, 1);
  assert.match(result.out, /scenario 1: Given required/);
  assert.match(result.out, /scenario 2: Then required/);
});

test("chore and task stories take the fast lane without aggregate or command", () => {
  const dir = setup(story(scenarios(2)));
  write(dir, "docs/stories/ST-002-bump.md", `---
id: ST-002
title: Bump a dependency
type: chore
priority: should
labels: [feature:tooling]
status: review
---

## Task
Upgrade the test runner.

## Acceptance Criteria
- [ ] The lockfile is updated
- [ ] The test suite is green
`);
  const result = lint(dir, ["ST-002"]);
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /Spec linter OK/);
});

test("the linter gate blocks ready-for-human-review, and ready needs the human step", () => {
  const dir = setup(story(scenarios(5)));
  const blocked = status(dir, "ST-001", "ready-for-human-review");
  assert.equal(blocked.code, 1, blocked.out);
  assert.match(blocked.out, /at most 4/);

  write(dir, "docs/stories/ST-001-place-order.md", story(scenarios(2)));
  const green = status(dir, "ST-001", "ready-for-human-review");
  assert.equal(green.code, 0, green.out);
  assert.match(green.out, /review → ready-for-human-review/);

  const shortcut = status(dir, "ST-001", "ready");
  assert.equal(shortcut.code, 0, shortcut.out);
  assert.match(readFileSync(join(dir, "docs/stories/ST-001-place-order.md"), "utf8"), /^status: ready$/m);
});

test("ready cannot be reached from review in one step", () => {
  const dir = setup(story(scenarios(2)));
  const result = status(dir, "ST-001", "ready");
  assert.equal(result.code, 1);
  assert.match(result.out, /needs 'ready-for-human-review' first/);
});

test("kataster lint-story delegates to the installed linter", () => {
  const dir = setup(story(scenarios(2)));
  const ok = spawnSync(process.execPath, [cli, "lint-story", "ST-001"], { cwd: dir, encoding: "utf8" });
  assert.equal(ok.status, 0, `${ok.stdout}${ok.stderr}`);
  assert.match(ok.stdout, /Spec linter OK/);

  write(dir, "docs/stories/ST-001-place-order.md", story(scenarios(5)));
  const bad = spawnSync(process.execPath, [cli, "lint-story", "ST-001"], { cwd: dir, encoding: "utf8" });
  assert.equal(bad.status, 1);
  assert.match(`${bad.stdout}${bad.stderr}`, /at most 4/);
});

test("legacy type: story stays valid on upgrade, with warnings instead of errors", () => {
  const legacy = `---
id: ST-003
title: Legacy order story
type: story
context: BC-Order
priority: should
events: [EVT-OrderPlaced]
depends_on: []
status: review
---

## Story
As a customer, I want to place an order, so that I get the goods.

## Acceptance Criteria

${scenarios(5)}
`;
  const dir = setup(story(scenarios(2)));
  write(dir, "docs/stories/ST-003-legacy.md", legacy);
  const result = lint(dir, ["ST-003"]);
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /legacy name of 'domain'/);
  assert.match(result.out, /at most 4/);
});
