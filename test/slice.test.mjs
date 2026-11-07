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
  const dir = mkdtempSync(join(tmpdir(), "kataster-slice-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "shop", scripts: { test: "vitest" } }), "utf8");
  const files = {
    "src/api/ordersController.ts": [
      'import { placeOrder } from "../services/orderService";',
      'export const route = "POST /orders";',
      'export const event = "EVT-OrderPlaced";',
      "export function handler() { return placeOrder(); }",
      "",
    ].join("\n"),
    "src/services/orderService.ts": [
      'import { saveOrder } from "../repositories/orderRepository";',
      "export function placeOrder() { return saveOrder(); }",
      "",
    ].join("\n"),
    "src/repositories/orderRepository.ts": 'export function saveOrder() { return "orders"; }\n',
    "src/services/customerService.ts": "export const customer = 1;\n",
    "db/migrations/001_orders.sql": "create table orders (id int);\n",
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

  const map = run(dir, "adopt", "repo-map.ts");
  assert.equal(map.code, 0, map.out);
  return dir;
}

function run(dir, folder, script, args = []) {
  const r = spawnSync(process.execPath, [join(dir, ".claude", "skills", folder, "scripts", script), ...args], {
    cwd: dir,
    encoding: "utf8",
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}`, stdout: r.stdout };
}

const slice = (dir, args) => run(dir, "adopt", "slice.ts", args);

test("--paths resolves a concept across the layers it imports", () => {
  const dir = repo();
  const result = slice(dir, ["--paths", "src/services/order*"]);
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /Candidate files \(/);
  assert.match(result.out, /src\/services\/orderService\.ts/);
  assert.match(result.out, /src\/repositories\/orderRepository\.ts/);
  assert.match(result.out, /src\/api\/ordersController\.ts/);
  assert.match(result.out, /imports src\/services\/orderService\.ts/);
  assert.match(result.out, /imported by src\/services\/orderService\.ts/);
});

test("--table and --route find the entry point and the layers behind it", () => {
  const dir = repo();
  const table = slice(dir, ["--table", "orders"]);
  assert.equal(table.code, 0, table.out);
  assert.match(table.out, /src\/repositories\/orderRepository\.ts/);
  assert.match(table.out, /src\/api\/ordersController\.ts/);
  assert.match(table.out, /db\/migrations\/001_orders\.sql/);

  const route = slice(dir, ["--route", "POST /orders"]);
  assert.equal(route.code, 0, route.out);
  assert.match(route.out, /src\/api\/ordersController\.ts/);
});

test("--event uses events.yaml and the code that names the event", () => {
  const dir = repo();
  const result = slice(dir, ["--event", "EVT-OrderPlaced"]);
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /src\/api\/ordersController\.ts/);
  assert.match(result.out, /event EVT-OrderPlaced/);
});

test("--cluster and --term use the map and the vocabulary", () => {
  const dir = repo();
  const cluster = slice(dir, ["--cluster", "order"]);
  assert.equal(cluster.code, 0, cluster.out);
  assert.match(cluster.out, /src\/api\/ordersController\.ts/);
  assert.match(cluster.out, /src\/services\/orderService\.ts/);
  assert.match(cluster.out, /db\/migrations\/001_orders\.sql/);

  const term = slice(dir, ["--term", "customer"]);
  assert.equal(term.code, 0, term.out);
  assert.match(term.out, /src\/services\/customerService\.ts/);
  assert.doesNotMatch(term.out, /src\/services\/orderService\.ts/);
});

test("--json is machine-readable and a miss exits non-zero with a warning", () => {
  const dir = repo();
  const result = slice(dir, ["--route", "POST /orders", "--json"]);
  assert.equal(result.code, 0, result.out);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.query, "--route POST /orders");
  assert.ok(parsed.seeds.length >= 1);
  assert.ok(parsed.files.some((file) => file.file === "src/api/ordersController.ts"));
  assert.ok(parsed.byLayer.api.includes("src/api/ordersController.ts"));

  const miss = slice(dir, ["--table", "does_not_exist"]);
  assert.equal(miss.code, 1, miss.out);
  assert.match(miss.out, /no file mentions table/);
});
