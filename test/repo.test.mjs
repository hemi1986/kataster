import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cli = resolve(here, "..", "bin", "kataster.mjs");

function repo(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), "kataster-repo-"));
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

function script(dir, name, ...args) {
  const r = spawnSync(process.execPath, [join(dir, ".claude", "skills", "adopt", "scripts", name), ...args], {
    cwd: dir,
    encoding: "utf8",
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const read = (dir, path) => readFileSync(join(dir, path), "utf8");
const json = (dir, path) => JSON.parse(read(dir, path));

function init(dir) {
  const result = run(["init", dir, "--yes", "--no-install"]);
  assert.equal(result.code, 0, result.out);
}

function monorepo() {
  return repo({
    "package.json": JSON.stringify({
      name: "acme",
      private: true,
      workspaces: ["apps/*", "libs/*"],
      scripts: { test: "nx run-many -t test", lint: "nx run-many -t lint" },
    }),
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    "pnpm-workspace.yaml": 'packages:\n  - "apps/*"\n  - "libs/*"\n',
    "nx.json": JSON.stringify({ targetDefaults: {} }),
    "apps/billing/package.json": JSON.stringify({
      name: "@acme/billing",
      dependencies: { "@acme/shared": "workspace:*", express: "^4" },
      scripts: { test: "vitest", build: "tsc" },
    }),
    "apps/billing/src/index.ts": "export const billing = true;\n",
    "apps/web/package.json": JSON.stringify({
      name: "@acme/web",
      dependencies: { "@acme/shared": "workspace:*" },
      scripts: { test: "vitest" },
    }),
    "apps/web/src/index.ts": "export const web = true;\n",
    "libs/shared/package.json": JSON.stringify({
      name: "@acme/shared",
      main: "src/index.ts",
      scripts: { test: "vitest" },
    }),
    "libs/shared/src/index.ts": "export const shared = true;\n",
  });
}

test("detects Nx with pnpm workspaces and builds the repository map", () => {
  const dir = monorepo();
  init(dir);

  const profile = json(dir, ".claude/project.json");
  assert.equal(profile.repo.tooling.kind, "nx");
  assert.equal(profile.repo.tooling.config, "nx.json");
  assert.equal(profile.repo.tooling.manager, "pnpm");
  assert.equal(profile.stack.packageManager, "pnpm");
  assert.equal(profile.commands.install, "pnpm install");
  assert.deepEqual(profile.repo.tooling.workspaces, ["apps/*", "libs/*"]);
  assert.equal(profile.repo.tooling.monorepo, true);

  const result = script(dir, "repo-map.ts");
  assert.equal(result.code, 0, result.out);

  const map = json(dir, "docs/architecture/repo-map.json");
  assert.equal(map.tooling.kind, "nx");
  assert.equal(map.packages.length, 3);

  const billing = map.packages.find((p) => p.path === "apps/billing");
  assert.equal(billing.name, "@acme/billing");
  assert.equal(billing.kind, "app");
  assert.deepEqual(billing.internalDeps, ["@acme/shared"]);
  assert.ok(billing.entryPoints.includes("src/index.ts"));

  const shared = map.packages.find((p) => p.path === "libs/shared");
  assert.equal(shared.kind, "library");
  assert.deepEqual(shared.consumers, ["@acme/billing", "@acme/web"]);

  assert.ok(map.ranking.length >= 3);
  assert.ok(map.ranking.every((r) => typeof r.score === "number" && Array.isArray(r.reasons)));

  const markdown = read(dir, "docs/architecture/repo-map.md");
  assert.match(markdown, /apps\/billing/);
  assert.match(markdown, /libs\/shared/);
  assert.match(markdown, /Suggested first slice/);
  assert.match(markdown, /nx affected -t test/);

  const agents = read(dir, "AGENTS.md");
  assert.match(agents, /kataster:repo:begin/);
  assert.match(agents, /Nx/);
  assert.match(agents, /nx run <project>:test/);
  assert.match(agents, /docs\/architecture\/repo-map\.md/);
});

test("writes package docs and preserves hand-written prose on refresh", () => {
  const dir = monorepo();
  init(dir);
  assert.equal(script(dir, "repo-map.ts").code, 0);

  const created = script(dir, "package-doc.ts", "apps/billing");
  assert.equal(created.code, 0, created.out);
  assert.match(created.out, /Created apps\/billing\/AGENTS\.md/);

  const agentsPath = "apps/billing/AGENTS.md";
  const doc = read(dir, agentsPath);
  assert.match(doc, /kataster:package:begin/);
  assert.match(doc, /nx run billing:test/);
  assert.match(doc, /Depends on.*@acme\/shared/);
  assert.match(doc, /## Purpose/);
  assert.match(doc, /## External interfaces/);
  assert.equal(read(dir, "apps/billing/CLAUDE.md"), "# @acme/billing\n\n@AGENTS.md\n");

  // The grilling fills the prose; a later refresh must keep it.
  const edited = doc.replace("[OPEN] Why does this package exist? One or two sentences, in the domain's words.", "Our billing service.");
  writeFileSync(join(dir, agentsPath), edited, "utf8");
  const refreshed = script(dir, "package-doc.ts", "apps/billing");
  assert.equal(refreshed.code, 0, refreshed.out);
  assert.match(read(dir, agentsPath), /Our billing service\./);
  assert.match(read(dir, agentsPath), /kataster:package:begin/);

  const lib = script(dir, "package-doc.ts", "libs/shared");
  assert.equal(lib.code, 0, lib.out);
  assert.match(read(dir, "libs/shared/AGENTS.md"), /## Public API/);
  assert.match(read(dir, "libs/shared/AGENTS.md"), /## Consumers/);

  // A hand-written package doc without markers is never overwritten, but Claude still gets its entry file.
  writeFileSync(join(dir, "apps/web/AGENTS.md"), "# Web\n\nHand-written.\n", "utf8");
  const kept = script(dir, "package-doc.ts", "apps/web");
  assert.equal(kept.code, 0, kept.out);
  assert.match(kept.out, /Kept apps\/web\/AGENTS\.md/);
  assert.match(read(dir, "apps/web/AGENTS.md"), /Hand-written\./);
  assert.equal(read(dir, "apps/web/CLAUDE.md"), "# @acme/web\n\n@AGENTS.md\n");

  assert.match(script(dir, "package-doc.ts", ".").out, /root package is documented in AGENTS\.md/);
});

test("marks a slice adopted and reports it in the root block and the map", () => {
  const dir = monorepo();
  init(dir);
  assert.equal(script(dir, "repo-map.ts").code, 0);

  const adopted = script(dir, "package-doc.ts", "apps/billing", "--adopt");
  assert.equal(adopted.code, 0, adopted.out);
  assert.match(adopted.out, /Marked adopted: apps\/billing/);

  const map = json(dir, "docs/architecture/repo-map.json");
  const billing = map.packages.find((p) => p.path === "apps/billing");
  assert.equal(billing.adopted, true);
  assert.match(billing.adoptedAt, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(read(dir, "AGENTS.md"), /Adopted slices:.*`apps\/billing`/);

  // A refresh of the generated map keeps the adoption state.
  assert.equal(script(dir, "repo-map.ts").code, 0);
  const refreshed = json(dir, "docs/architecture/repo-map.json");
  const again = refreshed.packages.find((p) => p.path === "apps/billing");
  assert.equal(again.adopted, true);
  assert.equal(again.adoptedAt, billing.adoptedAt);
});

test("upgrade keeps the repo map, package docs and project hooks", () => {
  const dir = monorepo();
  init(dir);
  assert.equal(script(dir, "repo-map.ts").code, 0);
  assert.equal(script(dir, "package-doc.ts", "apps/billing").code, 0);
  writeFileSync(
    join(dir, "apps/billing/AGENTS.md"),
    `${read(dir, "apps/billing/AGENTS.md")}\n## Notes\n\nHand-written during the grilling.\n`,
    "utf8",
  );

  // A project-owned hook under .claude/hooks/ must survive the upgrade.
  const settingsPath = join(dir, ".claude", "settings.json");
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  settings.hooks.PreToolUse.push({
    matcher: "Write",
    hooks: [{ type: "command", command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/project-check.ts"' }],
  });
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

  const upgraded = run(["upgrade", dir, "--no-install"]);
  assert.equal(upgraded.code, 0, upgraded.out);

  assert.match(read(dir, "AGENTS.md"), /kataster:repo:begin/);
  assert.match(read(dir, "apps/billing/AGENTS.md"), /Hand-written during the grilling\./);
  assert.ok(existsSync(join(dir, "docs/architecture/repo-map.json")));

  const after = json(dir, ".claude/settings.json");
  assert.ok(
    JSON.stringify(after.hooks.PreToolUse).includes("project-check.ts"),
    "project hook kept",
  );
  assert.ok(
    JSON.stringify(after.hooks.PreToolUse).includes("protect-files.ts"),
    "managed hook still there",
  );

  const manifest = json(dir, ".claude/install.json");
  assert.ok(!("apps/billing/AGENTS.md" in manifest.files), "package docs are project content");
  assert.ok(!("docs/architecture/repo-map.json" in manifest.files), "the map is project content");
});

test("detects Bazel and uses it for package commands", () => {
  const dir = repo({
    "MODULE.bazel": 'module(name = "acme")\n',
    "apps/svc/package.json": JSON.stringify({ name: "@acme/svc", scripts: { test: "vitest" } }),
    "apps/svc/src/index.ts": "export const svc = true;\n",
    "libs/lib/package.json": JSON.stringify({ name: "@acme/lib", scripts: { test: "vitest" } }),
    "libs/lib/src/index.ts": "export const lib = true;\n",
  });
  init(dir);
  assert.equal(json(dir, ".claude/project.json").repo.tooling.kind, "bazel");

  assert.equal(script(dir, "repo-map.ts").code, 0);
  const map = json(dir, "docs/architecture/repo-map.json");
  const svc = map.packages.find((p) => p.path === "apps/svc");
  assert.equal(svc.kind, "app");

  assert.equal(script(dir, "package-doc.ts", "apps/svc").code, 0);
  assert.match(read(dir, "apps/svc/AGENTS.md"), /bazel test \/\/apps\/svc\/\.\.\./);
});

test("lists Bazel BUILD packages when there is no manifest", () => {
  const dir = repo({
    "MODULE.bazel": 'module(name = "acme")\n',
    "apps/svc/BUILD.bazel": 'filegroup(name = "svc")\n',
    "apps/svc/main.go": "package main\n",
    "libs/lib/BUILD.bazel": 'filegroup(name = "lib")\n',
    "libs/lib/lib.go": "package lib\n",
  });
  init(dir);
  assert.equal(json(dir, ".claude/project.json").repo.tooling.kind, "bazel");

  assert.equal(script(dir, "repo-map.ts").code, 0);
  const map = json(dir, "docs/architecture/repo-map.json");
  const svc = map.packages.find((p) => p.path === "apps/svc");
  assert.equal(svc.kind, "app");
  assert.equal(svc.language, "Go");
  assert.equal(svc.manifest, "apps/svc/BUILD.bazel");
  assert.ok(map.packages.some((p) => p.path === "libs/lib" && p.kind === "library"));

  assert.equal(script(dir, "package-doc.ts", "apps/svc").code, 0);
  assert.match(read(dir, "apps/svc/AGENTS.md"), /bazel test \/\/apps\/svc\/\.\.\./);
});

test("handles a simple single-package repository and reports a stale map", () => {
  const dir = repo({
    "package.json": JSON.stringify({ name: "shop", scripts: { test: "vitest", build: "tsc" } }),
    "src/index.ts": "export const shop = true;\n",
  });
  init(dir);
  assert.equal(json(dir, ".claude/project.json").repo.tooling.kind, "none");

  assert.equal(script(dir, "repo-map.ts").code, 0);
  const map = json(dir, "docs/architecture/repo-map.json");
  assert.equal(map.packages.length, 1);
  assert.equal(map.packages[0].path, ".");
  assert.equal(map.packages[0].name, "shop");
  assert.match(read(dir, "AGENTS.md"), /none \(single package\)/);
  assert.match(script(dir, "package-doc.ts", ".").out, /root package is documented in AGENTS\.md/);

  assert.equal(script(dir, "repo-map.ts", "--check").code, 0);

  mkdirSync(join(dir, "libs", "new"), { recursive: true });
  writeFileSync(join(dir, "libs", "new", "package.json"), JSON.stringify({ name: "new", scripts: { test: "vitest" } }), "utf8");
  const stale = script(dir, "repo-map.ts", "--check");
  assert.equal(stale.code, 1);
  assert.match(stale.out, /repository map is stale|stale/);
  assert.match(stale.out, /libs\/new/);
});
