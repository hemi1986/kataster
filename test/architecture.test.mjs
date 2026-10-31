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

function repo(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), "kataster-arch-"));
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

function script(dir, name, args = [], options = {}) {
  const r = spawnSync(process.execPath, [join(dir, ".claude", "skills", "adopt", "scripts", name), ...args], {
    cwd: dir,
    encoding: "utf8",
    ...options,
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}`, stdout: r.stdout, stderr: r.stderr };
}

function hook(dir, name, args = [], options = {}) {
  const r = spawnSync(process.execPath, [join(dir, ".claude", "hooks", name), ...args], {
    cwd: dir,
    encoding: "utf8",
    ...options,
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}`, stdout: r.stdout, stderr: r.stderr };
}

const read = (dir, path) => readFileSync(join(dir, path), "utf8");
const json = (dir, path) => JSON.parse(read(dir, path));

function init(dir) {
  const result = run(["init", dir, "--yes", "--no-install"]);
  assert.equal(result.code, 0, result.out);
  // The scripts need the `yaml` runtime dependency; the installer normally runs `npm install --prefix .claude`.
  mkdirSync(join(dir, ".claude", "node_modules"), { recursive: true });
  cpSync(yamlSource, join(dir, ".claude", "node_modules", "yaml"), { recursive: true });
}

function archRepo() {
  return repo({
    "package.json": JSON.stringify({ name: "acme", private: true, workspaces: ["apps/*", "libs/*"] }),
    "apps/billing/package.json": JSON.stringify({ name: "@acme/billing", dependencies: { "@acme/shared": "workspace:*" } }),
    "apps/billing/src/index.ts": 'import { shared } from "../../../libs/shared/src";\nexport const billing = shared;\n',
    "apps/web/package.json": JSON.stringify({ name: "@acme/web", dependencies: { "@acme/shared": "workspace:*" } }),
    "apps/web/src/index.ts": 'import { billing } from "../../billing/src";\nexport const web = billing;\n',
    "libs/shared/package.json": JSON.stringify({ name: "@acme/shared", main: "src/index.ts" }),
    "libs/shared/src/index.ts": "export const shared = 1;\n",
  });
}

test("checks JS/TS boundaries, freezes existing debt and fails only new violations", () => {
  const dir = archRepo();
  init(dir);
  assert.equal(script(dir, "repo-map.ts").code, 0);

  const initialized = script(dir, "boundary-check.ts", ["--init"]);
  assert.equal(initialized.code, 0, initialized.out);
  assert.ok(existsSync(join(dir, "docs/architecture/boundaries.yaml")));
  assert.ok(existsSync(join(dir, "docs/architecture/boundaries.baseline.json")));
  assert.ok(existsSync(join(dir, "docs/engineering/checks.yaml")));
  assert.match(read(dir, "docs/architecture/boundaries.yaml"), /apps-do-not-import-apps/);

  const first = script(dir, "boundary-check.ts");
  assert.equal(first.code, 1, first.out);
  assert.match(first.out, /apps\/web\/src\/index\.ts:1/);
  assert.match(first.out, /apps-do-not-import-apps/);

  const asJson = script(dir, "boundary-check.ts", ["--json"]);
  assert.equal(asJson.code, 1, asJson.out);
  const report = JSON.parse(asJson.stdout);
  assert.equal(report.ok, false);
  assert.equal(report.new.length, 1);
  assert.equal(report.engine, "scan");

  assert.equal(script(dir, "boundary-check.ts", ["--update-baseline"]).code, 0);
  assert.equal(script(dir, "boundary-check.ts").code, 0);

  // A new violation in a changed file makes the edit hook red.
  writeFileSync(
    join(dir, "apps/web/src/other.ts"),
    'import { billing } from "../../billing/src";\nexport const other = billing;\n',
    "utf8",
  );
  const edit = hook(dir, "project-check.ts", [], {
    input: JSON.stringify({ tool_input: { file_path: "apps/web/src/other.ts" }, cwd: dir }),
  });
  assert.equal(edit.code, 2, edit.out);
  assert.match(edit.stderr, /apps\/web\/src\/other\.ts/);

  const stop = hook(dir, "project-check.ts", ["--phase", "stop"]);
  assert.equal(stop.code, 2, stop.out);

  assert.equal(script(dir, "boundary-check.ts", ["--update-baseline"]).code, 0);
  assert.equal(hook(dir, "project-check.ts", ["--phase", "stop"]).code, 0);

  // Changing a docs file does not trigger the boundary check.
  const docs = hook(dir, "project-check.ts", [], {
    input: JSON.stringify({ tool_input: { file_path: "docs/readme.md" }, cwd: dir }),
  });
  assert.equal(docs.code, 0, docs.out);
});

test("--init does not overwrite confirmed boundaries, but --force does", () => {
  const dir = archRepo();
  init(dir);
  assert.equal(script(dir, "repo-map.ts").code, 0);
  assert.equal(script(dir, "boundary-check.ts", ["--init"]).code, 0);

  writeFileSync(join(dir, "docs/architecture/boundaries.yaml"), "version: 1\nengine: auto\ncommand: \"\"\nrules: []\n", "utf8");
  const denied = script(dir, "boundary-check.ts", ["--init"]);
  assert.notEqual(denied.code, 0);
  assert.match(denied.out, /already exists/);

  const forced = script(dir, "boundary-check.ts", ["--init", "--force"]);
  assert.equal(forced.code, 0, forced.out);
  assert.match(read(dir, "docs/architecture/boundaries.yaml"), /apps-do-not-import-apps/);
});

test("the command engine ratchets the project's own architecture check", () => {
  const dir = repo({ "package.json": "{\"name\":\"x\"}\n", "src/index.ts": "export const x = 1;\n" });
  init(dir);
  mkdirSync(join(dir, "docs/architecture"), { recursive: true });
  writeFileSync(
    join(dir, "docs/architecture/boundaries.yaml"),
    'version: 1\nengine: command\ncommand: node -e "console.error(\'boom\'); process.exit(1)"\nrules: []\n',
    "utf8",
  );

  const red = script(dir, "boundary-check.ts");
  assert.equal(red.code, 1, red.out);
  assert.match(red.out, /boom/);

  assert.equal(script(dir, "boundary-check.ts", ["--update-baseline"]).code, 0);
  assert.equal(script(dir, "boundary-check.ts").code, 0);

  // A different failure output is a new violation, not the same debt.
  const boundaries = read(dir, "docs/architecture/boundaries.yaml").replace("boom", "boom2");
  writeFileSync(join(dir, "docs/architecture/boundaries.yaml"), boundaries, "utf8");
  const changed = script(dir, "boundary-check.ts");
  assert.equal(changed.code, 1, changed.out);
  assert.match(changed.out, /boom2/);
});

test("project checks can be advisory and are scoped by paths", () => {
  const dir = archRepo();
  init(dir);
  assert.equal(script(dir, "repo-map.ts").code, 0);
  assert.equal(script(dir, "boundary-check.ts", ["--init"]).code, 0);

  writeFileSync(
    join(dir, "docs/engineering/checks.yaml"),
    [
      "version: 1",
      "checks:",
      "  - name: advisory-note",
      '    command: node -e "console.error(\'advice\'); process.exit(1)"',
      "    phase: edit",
      "    paths:",
      '      - "apps/**"',
      "    advisory: true",
      "",
    ].join("\n"),
    "utf8",
  );

  const advisory = hook(dir, "project-check.ts", [], {
    input: JSON.stringify({ tool_input: { file_path: "apps/web/src/index.ts" }, cwd: dir }),
  });
  assert.equal(advisory.code, 0, advisory.out);
  assert.match(advisory.stdout, /advice/);
  assert.match(advisory.stdout, /additionalContext/);

  const outside = hook(dir, "project-check.ts", [], {
    input: JSON.stringify({ tool_input: { file_path: "libs/shared/src/index.ts" }, cwd: dir }),
  });
  assert.equal(outside.code, 0, outside.out);
  assert.equal(outside.stdout.trim(), "");
});

test("rule-doc scaffolds and validates path-scoped rules", () => {
  const dir = repo({ "package.json": "{\"name\":\"x\"}\n" });
  init(dir);

  const created = script(dir, "rule-doc.ts", ["libs-shared", "--paths", "libs/**", "--title", "Shared libraries"]);
  assert.equal(created.code, 0, created.out);
  const rule = read(dir, ".claude/rules/libs-shared.md");
  assert.match(rule, /^---/);
  assert.match(rule, /paths:/);
  assert.match(rule, /- "libs\/\*\*"/);
  assert.match(rule, /# Shared libraries/);

  assert.equal(script(dir, "rule-doc.ts", ["--check"]).code, 0);
  assert.match(script(dir, "rule-doc.ts", ["--list"]).out, /libs-shared\.md: libs\/\*\*/);

  const duplicate = script(dir, "rule-doc.ts", ["libs-shared", "--paths", "libs/**"]);
  assert.notEqual(duplicate.code, 0);
  assert.match(duplicate.out, /already exists/);

  writeFileSync(join(dir, ".claude/rules/broken.md"), "---\ntitle: no paths\n---\n# Broken\n", "utf8");
  const invalid = script(dir, "rule-doc.ts", ["--check"]);
  assert.equal(invalid.code, 1);
  assert.match(invalid.out, /paths is missing or empty/);
});
