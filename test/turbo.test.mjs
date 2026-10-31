import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cli = resolve(here, "..", "bin", "kataster.mjs");

function repo(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), "kataster-turbo-"));
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

function script(dir, name, args = []) {
  const r = spawnSync(process.execPath, [join(dir, ".claude", "skills", "adopt", "scripts", name), ...args], {
    cwd: dir,
    encoding: "utf8",
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}`, stdout: r.stdout };
}

function implement(dir, name, args = []) {
  const r = spawnSync(process.execPath, [join(dir, ".claude", "skills", "implement", "scripts", name), ...args], {
    cwd: dir,
    encoding: "utf8",
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}`, stdout: r.stdout };
}

const read = (dir, path) => readFileSync(join(dir, path), "utf8");
const json = (dir, path) => JSON.parse(read(dir, path));

function turboRepo() {
  const dir = repo({
    "package.json": JSON.stringify({
      name: "acme",
      private: true,
      workspaces: ["apps/*", "libs/*"],
      scripts: { test: "turbo run test" },
    }),
    "turbo.json": JSON.stringify({
      tasks: { build: { dependsOn: ["^build"] }, test: { dependsOn: ["^build"] } },
    }),
    "apps/billing/package.json": JSON.stringify({ name: "@acme/billing", dependencies: { "@acme/shared": "workspace:*" }, scripts: { test: "vitest" } }),
    "apps/billing/src/index.ts": 'import { shared } from "../../../libs/shared/src";\nexport const billing = shared;\n',
    "apps/web/package.json": JSON.stringify({ name: "@acme/web", dependencies: { "@acme/shared": "workspace:*" }, scripts: { test: "vitest" } }),
    "apps/web/src/index.ts": 'import { shared } from "../../../libs/shared/src";\nexport const web = shared;\n',
    "libs/shared/package.json": JSON.stringify({ name: "@acme/shared", scripts: { test: "vitest" } }),
    "libs/shared/src/index.ts": "export const shared = 1;\n",
  });

  // A stand-in for `node_modules/.bin/turbo`: repo-map only consumes `--dry=json`.
  const dry = {
    packages: ["@acme/billing", "@acme/shared", "@acme/web"],
    tasks: [
      { taskId: "@acme/billing#build", package: "@acme/billing", dependencies: ["@acme/shared#build"] },
      { taskId: "@acme/web#build", package: "@acme/web", dependencies: ["@acme/shared#build"] },
      { taskId: "@acme/shared#build", package: "@acme/shared", dependencies: [] },
    ],
  };
  const bin = join(dir, "node_modules", ".bin", "turbo");
  mkdirSync(dirname(bin), { recursive: true });
  writeFileSync(bin, `#!/bin/sh\ncat <<'JSON'\n${JSON.stringify(dry)}\nJSON\n`, "utf8");
  chmodSync(bin, 0o755);

  const result = run(["init", dir, "--yes", "--no-install"]);
  assert.equal(result.code, 0, result.out);
  return dir;
}

test("repo-map asks Turbo for the tool graph and keeps the manifest graph as fallback", () => {
  const dir = turboRepo();
  const mapped = script(dir, "repo-map.ts");
  assert.equal(mapped.code, 0, mapped.out);
  assert.match(mapped.out, /Tool graph: Turborepo \(build\)/);

  const map = json(dir, "docs/architecture/repo-map.json");
  assert.equal(map.toolGraph.source, "turbo");
  assert.equal(map.toolGraph.task, "build");
  assert.deepEqual(map.toolGraph.packages, ["@acme/billing", "@acme/shared", "@acme/web"]);
  assert.deepEqual(map.toolGraph.edges, [
    { from: "@acme/billing", to: "@acme/shared" },
    { from: "@acme/web", to: "@acme/shared" },
  ]);
  assert.match(read(dir, "docs/architecture/repo-map.md"), /Tool graph \(Turborepo\)/);
  assert.match(read(dir, "AGENTS.md"), /Tool graph:.*Turborepo/);

  // --check is environment-independent and does not need the Turbo binary.
  assert.equal(script(dir, "repo-map.ts", ["--check"]).code, 0);

  const without = script(dir, "repo-map.ts", ["--no-tool-graph"]);
  assert.equal(without.code, 0, without.out);
  assert.equal(json(dir, "docs/architecture/repo-map.json").toolGraph, undefined);
});

test("affected follows dependents and emits the Turbo filter command", () => {
  const dir = turboRepo();
  assert.equal(script(dir, "repo-map.ts").code, 0);

  const shared = implement(dir, "affected.ts", ["--changed", "libs/shared/src/index.ts"]);
  assert.equal(shared.code, 0, shared.out);
  assert.match(shared.out, /apps\/billing/);
  assert.match(shared.out, /apps\/web/);
  assert.match(shared.out, /libs\/shared/);
  assert.match(shared.out, /turbo run test --filter=@acme\/billing --filter=@acme\/web --filter=@acme\/shared/);

  const app = implement(dir, "affected.ts", ["--changed", "apps/billing/src/index.ts"]);
  assert.equal(app.code, 0, app.out);
  assert.match(app.out, /turbo run test --filter=@acme\/billing/);
  assert.doesNotMatch(app.out, /--filter=@acme\/web/);

  const root = implement(dir, "affected.ts", ["--changed", "package.json"]);
  assert.equal(root.code, 0, root.out);
  assert.match(root.out, /all – a root file changed/);
  assert.match(root.out, /turbo run test\n/);

  const asJson = implement(dir, "affected.ts", ["--changed", "libs/shared/src/index.ts", "--json"]);
  assert.equal(asJson.code, 0, asJson.out);
  const report = JSON.parse(asJson.stdout);
  assert.deepEqual(report.affected.map((p) => p.name), ["@acme/billing", "@acme/web", "@acme/shared"]);
  assert.equal(report.command, "turbo run test --filter=@acme/billing --filter=@acme/web --filter=@acme/shared");
});

test("affected uses the tool's native command for a git base", () => {
  const dir = turboRepo();
  assert.equal(script(dir, "repo-map.ts").code, 0);

  const base = implement(dir, "affected.ts", ["--base", "origin/main", "--json"]);
  assert.equal(base.code, 0, base.out);
  const report = JSON.parse(base.stdout);
  assert.equal(report.base, "origin/main");
  assert.equal(report.command, "turbo run test --filter='...[origin/main]'");

  const both = implement(dir, "affected.ts", ["--base", "origin/main", "--changed", "apps/billing/src/index.ts"]);
  assert.notEqual(both.code, 0);
  assert.match(both.out, /either --changed or --base/);
});
