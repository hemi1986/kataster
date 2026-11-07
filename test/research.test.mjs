import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { addMonths } from "../.claude/lib/research.ts";

const here = dirname(fileURLToPath(import.meta.url));
const cli = resolve(here, "..", "bin", "kataster.mjs");
const yamlSource = resolve(here, "..", ".claude", "node_modules", "yaml");

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "kataster-research-"));
  writeFileSync(join(dir, "package.json"), "{}", "utf8");
  const result = spawnSync(process.execPath, [cli, "init", dir, "--yes", "--no-install"], { cwd: dir, encoding: "utf8" });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
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

const check = (dir, args = []) => node(dir, "research/scripts/research-check.ts", args);

const events = `version: 1
domain: demo
actors:
  - id: ACT-Customer
    name: Customer
bounded_contexts:
  - id: BC-Order
    name: Order
    purpose: Taking orders.
aggregates:
  - id: AGG-Order
    name: Order
    context: BC-Order
events:
  - id: EVT-OrderPlaced
    name: Order placed
    aggregate: AGG-Order
commands:
  - id: CMD-PlaceOrder
    name: Place order
    actor: ACT-Customer
    aggregate: AGG-Order
    produces: [EVT-OrderPlaced]
`;

const scenarios = `Scenario: Order placed
  Given a cart
  When the order is placed
  Then it is recorded

Scenario: Empty cart
  Given an empty cart
  When the order is placed
  Then it is rejected
`;

function story(sources = "[]") {
  return `---
id: ST-001
title: Place an order
type: domain
context: BC-Order
aggregate: AGG-Order
command: CMD-PlaceOrder
priority: should
risk: high
events: [EVT-OrderPlaced]
sources: ${sources}
depends_on: []
status: review
---

## Story
As a customer, I want to place an order, so that I get the goods.

## Context
A valid cart.

## Acceptance Criteria

${scenarios}
`;
}

function researchFile(topic = "oauth", retrieved = "2026-11-07", expires = "2027-11-07") {
  return `---
topic: ${topic}
question: "Which PKCE configuration is required for a public SPA client?"
created: ${retrieved}
retrieved: ${retrieved}
expires: ${expires}
stack: ["node@22.18.0"]
---

# Research: ${topic}

## Question
Which PKCE configuration is required for a public SPA client?

## Findings

### F1 – PKCE S256 is required
- **Statement:** A public client uses the S256 code challenge.
- **Source:** RFC 7636 – https://www.rfc-editor.org/rfc/rfc7636 (4.2)
- **Retrieved:** ${retrieved}
- **Tier:** 1
- **Confidence:** high
- **Domain-model impact:** none

## Conflicts, caveats and gaps
- none

## Open questions for the grilling
- none
`;
}

function setup({ sources = "[]", research = "oauth", retrieved = "2026-11-07", expires = "2027-11-07" } = {}) {
  const dir = repo();
  write(dir, "docs/domain/events.yaml", events);
  write(dir, "docs/stories/ST-001-place-order.md", story(sources));
  if (research) write(dir, `docs/research/${research}.md`, researchFile(research, retrieved, expires));
  return dir;
}

test("a valid research file passes the topic check", () => {
  const dir = setup();
  const result = check(dir, ["--topic", "oauth"]);
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /VALID\s+docs\/research\/oauth\.md/);
  assert.match(result.out, /expires 2027-11-07/);
});

test("an expired research file is reported without becoming an invalid file", () => {
  const dir = setup({ retrieved: "2020-01-01", expires: "2021-01-01" });
  const result = check(dir, ["--topic", "oauth"]);
  assert.equal(result.code, 1, result.out);
  assert.match(result.out, /EXPIRED\s+docs\/research\/oauth\.md/);
  assert.doesNotMatch(result.out, /INVALID/);
});

test("missing and invalid referenced files are reported with the story that cites them", () => {
  const dir = setup({ sources: "[docs/research/missing.md]", research: "" });
  const missing = check(dir, ["--referenced"]);
  assert.equal(missing.code, 1, missing.out);
  assert.match(missing.out, /MISSING\s+docs\/research\/missing\.md/);
  assert.match(missing.out, /ST-001/);

  write(dir, "docs/research/broken.md", "---\ntopic: broken\n---\n\n# Research: broken\n");
  write(dir, "docs/stories/ST-001-place-order.md", story("[docs/research/broken.md]"));
  const invalid = check(dir, ["--referenced"]);
  assert.equal(invalid.code, 1, invalid.out);
  assert.match(invalid.out, /INVALID\s+docs\/research\/broken\.md/);
  assert.match(invalid.out, /ST-001/);
});

test("verify stays green with an expired referenced file and prints the research warning", () => {
  const dir = setup({ sources: "[docs/research/oauth.md]", retrieved: "2020-01-01", expires: "2021-01-01" });
  const result = node(dir, "implement/scripts/verify.ts");
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /research sources/);
  assert.match(result.out, /EXPIRED/);
  assert.match(result.out, /advisory, not blocking/);
});

test("the all mode checks every research file and ignores the README", () => {
  const dir = setup();
  write(dir, "docs/research/README.md", "# Research\n");
  const result = check(dir, ["--all"]);
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /Research check OK – 1 file\(s\)/);
  assert.doesNotMatch(result.out, /README\.md/);
});

test("the JSON output carries status, expiry and referencing stories", () => {
  const dir = setup({ sources: "[docs/research/oauth.md]" });
  const result = check(dir, ["--referenced", "--json"]);
  assert.equal(result.code, 0, result.out);
  const data = JSON.parse(result.out);
  assert.equal(data.ok, true);
  assert.equal(data.results[0].status, "valid");
  assert.equal(data.results[0].expires, "2027-11-07");
  assert.deepEqual(data.results[0].stories, ["ST-001"]);
});

test("expiry months clamp a month-end date in UTC", () => {
  assert.equal(addMonths("2026-11-07", 12), "2027-11-07");
  assert.equal(addMonths("2026-01-31", 1), "2026-02-28");
  assert.equal(addMonths("2024-01-31", 1), "2024-02-29");
  assert.equal(addMonths("2026-12-31", 2), "2027-02-28");
});
