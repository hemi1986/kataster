import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cli = resolve(here, "..", "bin", "kataster.mjs");
const yamlSource = resolve(here, "..", ".claude", "node_modules", "yaml");

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "kataster-gaps-"));
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
  const r = spawnSync(process.execPath, [join(dir, ".claude", "skills", "adopt", "scripts", script), ...args], {
    cwd: dir,
    encoding: "utf8",
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

function hook(dir, name, payload = {}) {
  const r = spawnSync(process.execPath, [join(dir, ".claude", "hooks", name)], {
    cwd: dir,
    input: JSON.stringify(payload),
    encoding: "utf8",
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const events = `version: 1
domain: demo
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
    status: as-is
    evidence:
      - orders table (db/schema.sql:12)
      - OrderService.place() (src/services/orderService.ts:88)
  - id: AGG-Invoice
    name: Invoice
    context: BC-Billing
    status: unresolved
events: []
hotspots:
  - id: HS-1
    question: Is the invoice its own consistency boundary?
    refs: [AGG-Invoice]
    status: open
`;

const targetMap = `# Target context map

## BC-Order – Order
Purpose: the target order context.
`;

const asIsMap = `# As-is context map

## BC-Order – Order
Recovered from the order tables and service.

## BC-Billing – Billing
Recovered from the invoice tables.
`;

function setup() {
  const dir = repo();
  write(dir, "docs/domain/events.yaml", events);
  write(dir, "docs/domain/context-map.md", targetMap);
  write(dir, "docs/domain/context-map.as-is.md", asIsMap);
  return dir;
}

test("the gap register links every as-is aggregate to both context maps", () => {
  const dir = setup();
  const result = node(dir, "gap-register.ts");
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /Created docs\/domain\/gap-register\.md/);

  const register = readFileSync(join(dir, "docs/domain/gap-register.md"), "utf8");
  assert.match(register, /GAP-AGG-Order/);
  assert.match(register, /as-is boundary/);
  assert.match(register, /\[BC-Order\]\(context-map\.as-is\.md#bc-order--order\)/);
  assert.match(register, /\[BC-Order\]\(context-map\.md#bc-order--order\)/);
  assert.match(register, /orders table \(db\/schema\.sql:12\)/);
  assert.match(register, /GAP-AGG-Invoice/);
  assert.match(register, /unresolved boundary/);
  assert.match(register, /\[BC-Billing\]\(context-map\.as-is\.md#bc-billing--billing\)/);
  assert.match(register, /Grill the boundary \(HS-1\)/);
});

test("--check is green for a fresh register and red when the model changes", () => {
  const dir = setup();
  assert.equal(node(dir, "gap-register.ts").code, 0);
  const fresh = node(dir, "gap-register.ts", ["--check"]);
  assert.equal(fresh.code, 0, fresh.out);
  assert.match(fresh.out, /up to date/);

  const changed = events.replace(
    "  - id: AGG-Invoice\n    name: Invoice\n    context: BC-Billing\n    status: unresolved\n",
    "  - id: AGG-Invoice\n    name: Invoice\n    context: BC-Billing\n    status: as-is\n    evidence:\n      - invoices table (db/schema.sql:40)\n",
  );
  write(dir, "docs/domain/events.yaml", changed);
  const stale = node(dir, "gap-register.ts", ["--check"]);
  assert.equal(stale.code, 1, stale.out);
  assert.match(stale.out, /stale/);
});

test("a missing register stays missing without a write, and --check is green", () => {
  const dir = setup();
  const check = node(dir, "gap-register.ts", ["--check"]);
  assert.equal(check.code, 0, check.out);
  assert.match(check.out, /no gap register yet/);
  const result = spawnSync(process.execPath, [join(dir, ".claude", "hooks", "validate-docs.ts")], {
    cwd: dir,
    input: JSON.stringify({ tool_input: { file_path: "docs/domain/events.yaml" }, cwd: dir }),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.equal(existsSync(join(dir, "docs/domain/gap-register.md")), false, "the hook must not create the register");
});

test("a hand-written register without markers is never overwritten", () => {
  const dir = setup();
  const custom = "# Gap register\n\nOur own decisions.\n";
  write(dir, "docs/domain/gap-register.md", custom);
  const result = node(dir, "gap-register.ts");
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /hand-written/);
  assert.equal(readFileSync(join(dir, "docs/domain/gap-register.md"), "utf8"), custom);
  assert.equal(node(dir, "gap-register.ts", ["--check"]).code, 0);
});

test("the events hook refreshes an existing register but does not create one", () => {
  const dir = setup();
  assert.equal(node(dir, "gap-register.ts").code, 0);

  const changed = events.replace(
    "  - id: AGG-Invoice\n    name: Invoice\n    context: BC-Billing\n    status: unresolved\n",
    "  - id: AGG-Invoice\n    name: Invoice\n    context: BC-Billing\n    status: as-is\n    evidence:\n      - invoices table (db/schema.sql:40)\n",
  );
  write(dir, "docs/domain/events.yaml", changed);
  const result = hook(dir, "validate-docs.ts", { tool_input: { file_path: "docs/domain/events.yaml" }, cwd: dir });
  assert.equal(result.code, 0, result.out);
  const register = readFileSync(join(dir, "docs/domain/gap-register.md"), "utf8");
  assert.match(register, /invoices table \(db\/schema\.sql:40\)/);
  assert.match(register, /as-is boundary/);
});
