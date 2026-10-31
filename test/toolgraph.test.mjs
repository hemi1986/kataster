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
  const dir = mkdtempSync(join(tmpdir(), "kataster-graph-"));
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

/** An Nx workspace whose manifests declare no internal edges – the graph is the only source of them. */
function nxRepo({ withBinary = true } = {}) {
  const dir = repo({
    "package.json": JSON.stringify({
      name: "acme",
      private: true,
      workspaces: ["apps/*", "libs/*"],
      scripts: { test: "nx run-many -t test" },
    }),
    "nx.json": JSON.stringify({ targetDefaults: {} }),
    "apps/billing/package.json": JSON.stringify({ name: "@acme/billing", scripts: { test: "vitest" } }),
    "apps/billing/src/index.ts": "export const billing = true;\n",
    "apps/web/package.json": JSON.stringify({ name: "@acme/web", scripts: { test: "vitest" } }),
    "apps/web/src/index.ts": "export const web = true;\n",
    "libs/shared/package.json": JSON.stringify({ name: "@acme/shared", scripts: { test: "vitest" } }),
    "libs/shared/src/index.ts": "export const shared = true;\n",
  });

  if (withBinary) {
    // A stand-in for `node_modules/.bin/nx`: repo-map only consumes the JSON written to --file=…
    const graph = {
      graph: {
        nodes: {
          billing: { name: "billing", type: "app", data: { root: "apps/billing" } },
          web: { name: "web", type: "app", data: { root: "apps/web" } },
          shared: { name: "shared", type: "lib", data: { root: "libs/shared" } },
        },
        dependencies: {
          billing: [{ source: "billing", target: "shared", type: "static" }],
          web: [{ source: "web", target: "shared", type: "static" }],
          shared: [],
        },
      },
    };
    const bin = join(dir, "node_modules", ".bin", "nx");
    mkdirSync(dirname(bin), { recursive: true });
    writeFileSync(
      bin,
      `#!/bin/sh\nfor arg in "$@"; do case "$arg" in --file=*) file="\${arg#--file=}" ;; esac; done\n[ -n "$file" ] || exit 1\ncat > "$file" <<'JSON'\n${JSON.stringify(graph)}\nJSON\n`,
      "utf8",
    );
    chmodSync(bin, 0o755);
  }

  const result = run(["init", dir, "--yes", "--no-install"]);
  assert.equal(result.code, 0, result.out);
  return dir;
}

test("Nx: repo-map stores the project graph, resolving Nx project names to packages", () => {
  const dir = nxRepo();
  const mapped = script(dir, "repo-map.ts");
  assert.equal(mapped.code, 0, mapped.out);
  assert.match(mapped.out, /Tool graph: Nx – 3 package\(s\), 2 edge\(s\)/);

  const map = json(dir, "docs/architecture/repo-map.json");
  assert.equal(map.tooling.kind, "nx");
  assert.equal(map.toolGraph.source, "nx");
  assert.equal(map.toolGraph.task, undefined);
  assert.deepEqual(map.toolGraph.packages, ["@acme/billing", "@acme/shared", "@acme/web"]);
  assert.deepEqual(map.toolGraph.edges, [
    { from: "@acme/billing", to: "@acme/shared" },
    { from: "@acme/web", to: "@acme/shared" },
  ]);
  assert.deepEqual(map.toolGraph.projectNames, {
    "@acme/billing": "billing",
    "@acme/shared": "shared",
    "@acme/web": "web",
  });
  // The manifests have no internal dependencies – the edges come from the tool alone.
  assert.ok(map.packages.every((p) => p.internalDeps.length === 0));

  const markdown = read(dir, "docs/architecture/repo-map.md");
  assert.match(markdown, /## Tool graph \(Nx\)/);
  assert.match(markdown, /nx graph --file=<temp>/);
  assert.match(markdown, /Tool graph:\*\* Nx – 3 package\(s\), 2 edge\(s\)/);
  assert.match(read(dir, "AGENTS.md"), /Tool graph:\*\* Nx/);
});

test("Nx: affected follows the project graph and emits Nx project names", () => {
  const dir = nxRepo();
  assert.equal(script(dir, "repo-map.ts").code, 0);

  const shared = implement(dir, "affected.ts", ["--changed", "libs/shared/src/index.ts"]);
  assert.equal(shared.code, 0, shared.out);
  assert.match(shared.out, /apps\/billing/);
  assert.match(shared.out, /apps\/web/);
  assert.match(shared.out, /nx run-many -t test -p billing,web,shared/);

  const app = implement(dir, "affected.ts", ["--changed", "apps/billing/src/index.ts"]);
  assert.equal(app.code, 0, app.out);
  assert.match(app.out, /nx run-many -t test -p billing/);
  assert.doesNotMatch(app.out, /-p billing,/);

  const asJson = implement(dir, "affected.ts", ["--base", "origin/main", "--json"]);
  assert.equal(asJson.code, 0, asJson.out);
  const report = JSON.parse(asJson.stdout);
  assert.equal(report.source, "nx:graph+manifests");
  assert.equal(report.command, "nx affected -t test --base=origin/main");
});

test("Nx without the binary falls back to the manifest graph", () => {
  const dir = nxRepo({ withBinary: false });
  const mapped = script(dir, "repo-map.ts");
  assert.equal(mapped.code, 0, mapped.out);
  assert.match(mapped.out, /Tool graph: Nx graph not available/);

  const map = json(dir, "docs/architecture/repo-map.json");
  assert.equal(map.toolGraph, undefined);
  assert.match(read(dir, "docs/architecture/repo-map.md"), /no Nx graph found/);
});

function bazelRepo() {
  const dir = repo({
    WORKSPACE: "",
    "apps/billing/BUILD": [
      'cc_library(name = "billing",',
      "  deps = [",
      '    "//libs/shared:shared",',
      '    "//apps/web:web",  # apps must not import apps – recorded, the rules decide',
      "  ],",
      ")",
      "",
    ].join("\n"),
    "apps/billing/src/main.cc": "int main() { return 0; }\n",
    "apps/web/BUILD": ['cc_library(name = "web",', '  deps = select({', '    "//conditions:default": ["//libs/shared"],', '    ":fast": ["//libs/shared"],', "  }),", ")", ""].join("\n"),
    "apps/web/src/main.cc": "int main() { return 0; }\n",
    "libs/shared/BUILD": 'cc_library(name = "shared", visibility = ["//visibility:public"])\n',
    "libs/shared/shared.cc": "int shared() { return 1; }\n",
  });
  const result = run(["init", dir, "--yes", "--no-install"]);
  assert.equal(result.code, 0, result.out);
  return dir;
}

test("Bazel: the BUILD files are the tool graph", () => {
  const dir = bazelRepo();
  const mapped = script(dir, "repo-map.ts");
  assert.equal(mapped.code, 0, mapped.out);
  assert.match(mapped.out, /Tool graph: Bazel – 3 package\(s\), 3 edge\(s\)/);

  const map = json(dir, "docs/architecture/repo-map.json");
  assert.equal(map.tooling.kind, "bazel");
  assert.equal(map.toolGraph.source, "bazel");
  assert.deepEqual(map.toolGraph.edges, [
    { from: "billing", to: "shared" },
    { from: "billing", to: "web" },
    { from: "web", to: "shared" },
  ]);
  assert.match(read(dir, "docs/architecture/repo-map.md"), /## Tool graph \(Bazel\)/);

  const shared = implement(dir, "affected.ts", ["--changed", "libs/shared/shared.cc", "--json"]);
  assert.equal(shared.code, 0, shared.out);
  const report = JSON.parse(shared.stdout);
  assert.deepEqual(report.affected.map((p) => p.path), ["apps/billing", "apps/web", "libs/shared"]);
  assert.equal(report.source, "bazel:graph+manifests");
  assert.equal(report.command, "bazel test //apps/billing/... //apps/web/... //libs/shared/...");
});

test("an unknown tooling kind never gains a tool graph", () => {
  const dir = repo({
    "package.json": JSON.stringify({ name: "solo", scripts: { test: "vitest" } }),
    "src/index.ts": "export const solo = true;\n",
  });
  assert.equal(run(["init", dir, "--yes", "--no-install"]).code, 0);
  const mapped = script(dir, "repo-map.ts");
  assert.equal(mapped.code, 0, mapped.out);
  assert.equal(json(dir, "docs/architecture/repo-map.json").toolGraph, undefined);
  assert.doesNotMatch(mapped.out, /Tool graph:/);
});
