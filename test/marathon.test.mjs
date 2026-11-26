import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { marathonStateErrors, planWave } from "../.claude/lib/engineering.ts";
import { parseJsonc } from "../src/util.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const cli = resolve(here, "..", "bin", "kataster.mjs");
const yamlSource = resolve(here, "..", ".claude", "node_modules", "yaml");

// --------------------------------------------------------------------------
// planWave – pure, stories and state passed in
// --------------------------------------------------------------------------
function story(id, meta = {}) {
  return { path: `/repo/docs/stories/${id}.md`, meta: { id, title: `Title of ${id}`, type: "story", size: "S", status: "ready", priority: "should", ...meta }, body: "" };
}
const backlog = (...stories) => new Map(stories.map((s) => [s.meta.id, s]));
const ids = (plan) => plan.wave.map((w) => w.story.meta.id);

function state(overrides = {}) {
  return { version: 1, run: "run-1", integrationBranch: "marathon/run-1", claims: {}, results: {}, escalations: [], ...overrides };
}

test("planWave: a story waits until every dependency is done", () => {
  const stories = backlog(
    story("ST-001", { status: "done" }),
    story("ST-002", { depends_on: ["ST-001"] }),
    story("ST-003", { depends_on: ["ST-002"], priority: "must" }),
    story("ST-004", { depends_on: ["ST-001", "ST-009"] }),
  );
  const plan = planWave(stories, null, 1);
  assert.deepEqual(ids(plan), ["ST-002"]);
  assert.equal(plan.reason, null);
  assert.deepEqual(
    plan.blocked.map((b) => [b.story.meta.id, b.waitingFor]),
    [["ST-003", ["ST-002"]], ["ST-004", ["ST-009"]]],
  );
});

test("planWave: only ready stories, in backlog order (priority first)", () => {
  const stories = backlog(
    story("ST-001", { priority: "could" }),
    story("ST-002", { priority: "must" }),
    story("ST-003", { status: "in-progress", priority: "must" }),
    story("ST-004", { status: "ready-for-human-review", priority: "must" }),
  );
  assert.deepEqual(ids(planWave(stories, null, 1)), ["ST-002"]);
});

test("planWave: escalated stories are skipped", () => {
  const stories = backlog(story("ST-001", { priority: "must" }), story("ST-002"));
  const plan = planWave(stories, state({ escalations: [{ story: "ST-001", reason: "verify keeps failing", at: "2026-11-26T10:00:00Z" }] }), 1);
  assert.deepEqual(ids(plan), ["ST-002"]);
  assert.deepEqual(plan.escalated, ["ST-001"]);

  const onlyEscalated = planWave(backlog(story("ST-001")), state({ escalations: [{ story: "ST-001", reason: "", at: "2026-11-26T10:00:00Z" }] }), 1);
  assert.deepEqual(ids(onlyEscalated), []);
  assert.match(onlyEscalated.reason, /claimed, handed over or escalated/);
});

test("planWave: an empty backlog plans nothing and says why", () => {
  const plan = planWave(new Map(), null, 1);
  assert.deepEqual(plan.wave, []);
  assert.equal(plan.reason, "the backlog is empty");

  const nothingReady = planWave(backlog(story("ST-001", { status: "done" }), story("ST-002", { status: "draft" })), null, 1);
  assert.deepEqual(nothingReady.wave, []);
  assert.equal(nothingReady.reason, "no story is ready");
});

test("planWave: a resumed run keeps its claims, skips handed-over stories and retries failed ones", () => {
  const stories = backlog(
    story("ST-001", { priority: "must" }),
    story("ST-002", { priority: "must" }),
    story("ST-003"),
    story("ST-004", { priority: "could" }),
  );
  // ST-001 is still held by a worker: with N = 1 there is no free slot.
  const busy = state({ claims: { "ST-001": { branch: "story/ST-001", start: "2026-11-26T09:00:00Z", attempts: 1 } } });
  const waiting = planWave(stories, busy, 1);
  assert.deepEqual(waiting.wave, []);
  assert.equal(waiting.slots, 0);
  assert.deepEqual(waiting.claimed, ["ST-001"]);
  assert.match(waiting.reason, /no free worker – 1 open claim/);

  // The pass on ST-001 ended (handed over), ST-002 failed once: the next wave retries ST-002 and counts on.
  const resumed = state({
    results: {
      "ST-001": { outcome: "handed-over", at: "2026-11-26T09:40:00Z", branch: "story/ST-001", attempts: 1 },
      "ST-002": { outcome: "failed", at: "2026-11-26T10:10:00Z", attempts: 2 },
    },
  });
  const plan = planWave(stories, resumed, 1);
  assert.deepEqual(ids(plan), ["ST-002"]);
  assert.equal(plan.wave[0].attempts, 2);
  assert.deepEqual(plan.handedOver, ["ST-001"]);
  assert.equal(plan.eligible, 3);
});

test("planWave: N is the worker count – the wave fills the free slots", () => {
  const stories = backlog(story("ST-001"), story("ST-002"), story("ST-003"), story("ST-004"));
  const run = state({ claims: { "ST-001": { branch: "story/ST-001", start: "2026-11-26T09:00:00Z", attempts: 1 } } });
  const plan = planWave(stories, run, 3);
  assert.equal(plan.slots, 2);
  assert.deepEqual(ids(plan), ["ST-002", "ST-003"]);
  assert.throws(() => planWave(stories, run, 0), /N must be a whole number/);
});

test("marathonStateErrors: names every broken field", () => {
  assert.deepEqual(marathonStateErrors(state()), []);
  const errs = marathonStateErrors({ version: 2, claims: { "ST-001": { branch: "b" } }, results: { "ST-002": { outcome: "merged" } }, escalations: {} });
  assert.equal(errs.length, 6, errs.join("\n"));
  assert.deepEqual(marathonStateErrors([]), ["the state is not a JSON object"]);
});

// --------------------------------------------------------------------------
// marathon-plan.ts – installed into a project, run like a harness runs it
// --------------------------------------------------------------------------
function repo() {
  const dir = mkdtempSync(join(tmpdir(), "kataster-marathon-"));
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

function storyFile(dir, id, status, extra = "") {
  write(dir, `docs/stories/${id}-demo.md`, `---\nid: ${id}\ntitle: Demo ${id}\ntype: chore\nstatus: ${status}\npriority: should\nsize: S\n${extra}---\n\nBody.\n`);
}

/** Runs the planner the way both harnesses do: `node .claude/skills/marathon/scripts/marathon-plan.ts`, from `cwd`. */
function plan(dir, args = [], cwd = dir) {
  const r = spawnSync(process.execPath, [join(dir, ".claude", "skills", "marathon", "scripts", "marathon-plan.ts"), ...args], { cwd, encoding: "utf8" });
  return { code: r.status, out: `${r.stdout}${r.stderr}`, stdout: r.stdout };
}

test("marathon-plan.ts: reads the claim state from .claude/state/marathon.json, from any cwd", () => {
  const dir = repo();
  storyFile(dir, "ST-001", "done");
  storyFile(dir, "ST-002", "ready", "depends_on: [ST-001]\n");
  storyFile(dir, "ST-003", "ready");

  const fresh = JSON.parse(plan(dir, ["--json"]).stdout);
  assert.equal(fresh.run, null);
  assert.equal(fresh.stateFile, ".claude/state/marathon.json");
  assert.deepEqual(fresh.wave.map((w) => w.id), ["ST-002"]);

  write(dir, ".claude/state/marathon.json", JSON.stringify(state({ escalations: [{ story: "ST-002", reason: "unclear rule", at: "2026-11-26T10:00:00Z" }] })));
  // A harness may run the shell from a subdirectory – the state path does not depend on it.
  mkdirSync(join(dir, "src"), { recursive: true });
  const resumed = JSON.parse(plan(dir, ["--json"], join(dir, "src")).stdout);
  assert.equal(resumed.run, "run-1");
  assert.equal(resumed.integrationBranch, "marathon/run-1");
  assert.deepEqual(resumed.wave.map((w) => w.id), ["ST-003"]);
  assert.deepEqual(resumed.escalated, ["ST-002"]);

  const text = plan(dir);
  assert.equal(text.code, 0, text.out);
  assert.match(text.out, /RUN {10}run-1 → marathon\/run-1/);
  assert.match(text.out, /NEXT {9}ST-003/);
  assert.match(text.out, /ESCALATED {4}ST-002/);
});

test("marathon-plan.ts: refuses a broken state file and N > 1", () => {
  const dir = repo();
  storyFile(dir, "ST-001", "ready");
  write(dir, ".claude/state/marathon.json", "{ not json");
  const broken = plan(dir);
  assert.equal(broken.code, 1);
  assert.match(broken.out, /marathon\.json is not valid JSON/);

  write(dir, ".claude/state/marathon.json", JSON.stringify({ version: 1 }));
  const invalid = plan(dir);
  assert.equal(invalid.code, 1);
  assert.match(invalid.out, /integrationBranch is missing/);

  const two = plan(dir, ["--n", "2"]);
  assert.equal(two.code, 2);
  assert.match(two.out, /conflict keys/);
  assert.equal(plan(dir, ["--n", "0"]).code, 2);
  assert.equal(plan(dir, ["--bogus"]).code, 2);
});

test("install: both harnesses may run the marathon scripts without a prompt", () => {
  const dir = repo();
  const settings = JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf8"));
  assert.ok(settings.permissions.allow.includes("Bash(node .claude/skills/marathon/scripts/*)"));
  const config = parseJsonc(readFileSync(join(dir, ".opencode", "opencode.jsonc"), "utf8"));
  assert.ok(config.permissions.some((r) => r.action === "shell" && r.resource === "node .claude/skills/marathon/scripts/*" && r.effect === "allow"));
});
