import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cli = resolve(here, "..", "bin", "kataster.mjs");
const yamlSource = resolve(here, "..", ".claude", "node_modules", "yaml");

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "kataster-context-map-"));
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

test("story-context shows the target and as-is sections of its context", () => {
  const dir = repo();
  write(dir, "docs/domain/events.yaml", `version: 1
domain: demo
bounded_contexts:
  - id: BC-Order
    name: Order
    purpose: Taking orders.
aggregates:
  - id: AGG-Order
    name: Order
    context: BC-Order
    status: as-is
    evidence:
      - orders table (db/schema.sql:12)
events:
  - id: EVT-OrderPlaced
    name: Order placed
    aggregate: AGG-Order
commands:
  - id: CMD-PlaceOrder
    name: Place order
    aggregate: AGG-Order
    produces: [EVT-OrderPlaced]
`);
  write(dir, "docs/domain/context-map.md", `# Target context map

## BC-Order – Order
Purpose: the target order context.
`);
  write(dir, "docs/domain/context-map.as-is.md", `# As-is context map

### BC-Order – Order
Evidence: orders table and OrderService.place().
`);
  write(dir, "docs/stories/ST-001-place-order.md", `---
id: ST-001
title: Place an order
type: domain
context: BC-Order
aggregate: AGG-Order
command: CMD-PlaceOrder
priority: should
events: [EVT-OrderPlaced]
status: review
---

## Story
As a customer, I want to place an order, so that I get the goods.

## Acceptance Criteria

Scenario: Order placed
  Given a cart
  When the order is placed
  Then it is recorded

Scenario: Empty cart
  Given an empty cart
  When the order is placed
  Then it is rejected
`);

  const result = spawnSync(
    process.execPath,
    [join(dir, ".claude", "skills", "implement", "scripts", "story-context.ts"), "ST-001"],
    { cwd: dir, encoding: "utf8" },
  );
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  const out = `${result.stdout}${result.stderr}`;
  assert.match(out, /## Context maps/);
  assert.match(out, /### Target \(`docs\/domain\/context-map\.md`\)/);
  assert.match(out, /the target order context/);
  assert.match(out, /### As-is \(`docs\/domain\/context-map\.as-is\.md`\)/);
  assert.match(out, /orders table and OrderService\.place\(\)/);
});
