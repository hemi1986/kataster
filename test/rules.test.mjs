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

function repo(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), "kataster-rules-"));
  for (const [path, content] of Object.entries(files)) {
    const target = join(dir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
  }
  const result = spawnSync(process.execPath, [cli, "init", dir, "--yes", "--no-install"], { cwd: dir, encoding: "utf8" });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  // The scripts need the `yaml` runtime dependency; the installer normally runs `npm install --prefix .claude`.
  mkdirSync(join(dir, ".claude", "node_modules"), { recursive: true });
  cpSync(yamlSource, join(dir, ".claude", "node_modules", "yaml"), { recursive: true });
  return dir;
}

function script(dir, name, args = []) {
  const r = spawnSync(process.execPath, [join(dir, ".claude", "skills", "adopt", "scripts", name), ...args], {
    cwd: dir,
    encoding: "utf8",
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

function hook(dir, payload) {
  const r = spawnSync(process.execPath, [join(dir, ".claude", "hooks", "path-rules.ts")], {
    cwd: dir,
    input: typeof payload === "string" ? payload : JSON.stringify(payload),
    encoding: "utf8",
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}`, stdout: r.stdout };
}

function rules(dir, payload) {
  const result = hook(dir, payload);
  assert.equal(result.code, 0, result.out);
  return JSON.parse(result.stdout || '{"rules":[]}').rules;
}

function workspace() {
  const dir = repo({
    "package.json": JSON.stringify({ name: "acme", private: true, workspaces: ["apps/*", "libs/*"] }),
    "apps/billing/src/index.ts": "export const billing = true;\n",
    "libs/shared/src/index.ts": "export const shared = true;\n",
    "db/migrations/001-init.sql": "create table t (id int);\n",
  });
  for (const [slug, paths, title] of [
    ["libs-shared", "libs/**", "Shared libraries"],
    ["sql-transactions", "**/*.sql", "SQL transactions"],
    ["migrations", "**/migrations/**", "Migrations"],
  ]) {
    const created = script(dir, "rule-doc.ts", [slug, "--paths", paths, "--title", title]);
    assert.equal(created.code, 0, created.out);
  }
  return dir;
}

test("path-rules resolves the same globs as Claude Code", () => {
  const dir = workspace();

  assert.deepEqual(rules(dir, { paths: ["libs/shared/src/index.ts"] }).map((r) => r.key), ["libs-shared"]);

  // Overlapping rules both apply, in rule-file order.
  assert.deepEqual(rules(dir, { paths: ["db/migrations/001.sql"] }).map((r) => r.key), ["migrations", "sql-transactions"]);

  assert.deepEqual(rules(dir, { paths: ["apps/billing/src/index.ts"] }), []);
});

test("path-rules returns the body without frontmatter and names the scope", () => {
  const dir = workspace();
  const [rule] = rules(dir, { paths: ["libs/shared/src/index.ts"] });
  assert.equal(rule.key, "libs-shared");
  assert.match(rule.value, /^Applies to `libs\/\*\*`\./);
  assert.match(rule.value, /# Shared libraries/);
  assert.doesNotMatch(rule.value, /^---/);
});

test("path-rules accepts absolute paths and the Claude tool_input shape", () => {
  const dir = workspace();
  const absolute = join(dir, "libs/shared/src/index.ts");
  assert.deepEqual(rules(dir, { paths: [absolute], cwd: dir }).map((r) => r.key), ["libs-shared"]);
  assert.deepEqual(rules(dir, { tool_input: { file_path: "libs/shared/src/index.ts" }, cwd: dir }).map((r) => r.key), ["libs-shared"]);
  assert.deepEqual(rules(dir, { paths: [join(dir, "..", "outside.ts")], cwd: dir }), []);
});

test("path-rules is quiet and safe when there is nothing to match", () => {
  const dir = repo({ "package.json": JSON.stringify({ name: "solo" }) });
  assert.deepEqual(rules(dir, { paths: ["src/index.ts"] }), []);
  assert.equal(hook(dir, "not json").code, 0);
  assert.deepEqual(hook(dir, "not json").stdout, "");
  assert.deepEqual(rules(dir, {}), []);
});
