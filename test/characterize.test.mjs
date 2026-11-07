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
  const dir = mkdtempSync(join(tmpdir(), "kataster-characterize-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "shop", scripts: { test: "vitest" } }), "utf8");
  const files = {
    "src/services/orderService.ts": [
      "// CMD-PlaceOrder",
      "export function placeOrder() { return true; }",
      "",
    ].join("\n"),
    "src/services/orderService.spec.ts": [
      'import { placeOrder } from "./orderService";',
      'test("places an order", () => { expect(placeOrder()).toBe(true); });',
      "",
    ].join("\n"),
    "src/api/ordersController.ts": [
      "// EVT-OrderPlaced",
      "export function handler() { return true; }",
      "",
    ].join("\n"),
    "docs/domain/events.yaml": [
      "version: 1",
      "domain: demo",
      "bounded_contexts:",
      "  - id: BC-Order",
      "    name: Order",
      "    purpose: Taking orders.",
      "aggregates:",
      "  - id: AGG-Order",
      "    name: Order",
      "    context: BC-Order",
      "events:",
      "  - id: EVT-OrderPlaced",
      "    name: Order placed",
      "    aggregate: AGG-Order",
      "commands:",
      "  - id: CMD-PlaceOrder",
      "    name: Place order",
      "    aggregate: AGG-Order",
      "    produces: [EVT-OrderPlaced]",
      "",
    ].join("\n"),
    "docs/stories/ST-012-place-order.md": [
      "---",
      "id: ST-012",
      "title: Place an order",
      "type: domain",
      "context: BC-Order",
      "aggregate: AGG-Order",
      "command: CMD-PlaceOrder",
      "priority: should",
      "events: [EVT-OrderPlaced]",
      "status: ready",
      "---",
      "",
      "## Story",
      "As a customer, I want to place an order, so that I get the goods.",
      "",
      "## Acceptance Criteria",
      "",
      "Scenario: Order placed",
      "  Given a cart",
      "  When the order is placed",
      "  Then it is recorded",
      "",
      "Scenario: Empty cart",
      "  Given an empty cart",
      "  When the order is placed",
      "  Then it is rejected",
      "",
    ].join("\n"),
  };
  for (const [path, content] of Object.entries(files)) {
    const target = join(dir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
  }
  const result = spawnSync(process.execPath, [cli, "init", dir, "--yes", "--no-install"], { cwd: dir, encoding: "utf8" });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  mkdirSync(join(dir, ".claude", "node_modules"), { recursive: true });
  cpSync(yamlSource, join(dir, ".claude", "node_modules", "yaml"), { recursive: true });
  return dir;
}

function characterize(dir, args = []) {
  const r = spawnSync(
    process.execPath,
    [join(dir, ".claude", "skills", "implement", "scripts", "characterize.ts"), ...args],
    { cwd: dir, encoding: "utf8" },
  );
  return { code: r.status, out: `${r.stdout}${r.stderr}`, stdout: r.stdout };
}

test("--story finds affected files and reports which ones have a test", () => {
  const dir = repo();
  const result = characterize(dir, ["--story", "ST-012"]);
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /src\/services\/orderService\.ts.*test found/);
  assert.match(result.out, /src\/api\/ordersController\.ts.*NO TEST FOUND/);
  assert.match(result.out, /src\/services\/orderService\.spec\.ts/);
  assert.match(result.out, /write a characterization test first/);
});

test("--changed is enough when the story does not name the files", () => {
  const dir = repo();
  const result = characterize(dir, ["--changed", "src/api/ordersController.ts", "--json"]);
  assert.equal(result.code, 0, result.out);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.sources.length, 1);
  assert.equal(parsed.sources[0].file, "src/api/ordersController.ts");
  assert.equal(parsed.sources[0].covered, false);
  assert.deepEqual(parsed.warnings, []);
});

test("a missing story fails, and the check never pretends a test file is behavioural coverage", () => {
  const dir = repo();
  const missing = characterize(dir, ["--story", "ST-999"]);
  assert.equal(missing.code, 1);
  assert.match(missing.out, /not found/);

  const result = characterize(dir, ["--changed", "src/services/orderService.ts", "--json"]);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.sources[0].covered, true);
  assert.equal(parsed.sources[0].confidence, "medium");
});
