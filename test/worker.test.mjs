import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { changedPaths } from "../.claude/lib/git.ts";
import { parseDetails, planStart, reportErrors } from "../.claude/lib/worker.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const cli = resolve(root, "bin", "kataster.mjs");
const yamlSource = resolve(root, ".claude", "node_modules", "yaml");

const STORY = "docs/stories/ST-012-place-order.md";
const story = (status, ticked = false) =>
  [
    "---",
    "id: ST-012",
    "title: Place an order",
    "type: chore",
    "priority: should",
    `status: ${status}`,
    "---",
    "",
    "## Story",
    "Keep the order module tidy.",
    "",
    "## Acceptance Criteria",
    "",
    `- [${ticked ? "x" : " "}] The helper is extracted`,
    "",
  ].join("\n");

function git(dir, ...args) {
  const r = spawnSync("git", ["-c", "user.email=worker@example.test", "-c", "user.name=Worker", ...args], { cwd: dir, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stdout}${r.stderr}`);
  return r.stdout.trim();
}

function write(dir, path, content) {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), content, "utf8");
}

/** An installed project on the integration branch `marathon/run-1`, with ST-012 `ready` and committed. */
function repo(status = "ready") {
  const dir = mkdtempSync(join(tmpdir(), "kataster-worker-"));
  write(dir, "package.json", JSON.stringify({ name: "shop" }));
  write(dir, "src/order.ts", "export const order = 1;\n");
  write(dir, STORY, story(status));
  const init = spawnSync(process.execPath, [cli, "init", dir, "--yes", "--no-install"], { cwd: dir, encoding: "utf8" });
  assert.equal(init.status, 0, `${init.stdout}${init.stderr}`);
  mkdirSync(join(dir, ".claude", "node_modules"), { recursive: true });
  cpSync(yamlSource, join(dir, ".claude", "node_modules", "yaml"), { recursive: true });
  git(dir, "init", "-q", "-b", "marathon/run-1");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  return dir;
}

function worker(dir, args, input) {
  const r = spawnSync(process.execPath, [join(dir, ".claude", "skills", "implement", "scripts", "worker.ts"), ...args], {
    cwd: dir,
    encoding: "utf8",
    input: input === undefined ? undefined : JSON.stringify(input),
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}`, stdout: r.stdout };
}

const start = (dir, ...extra) => worker(dir, ["start", "ST-012", "--base", "marathon/run-1", ...extra]);
const report = (dir, result, details) =>
  worker(dir, ["report", "ST-012", "--base", "marathon/run-1", "--result", result, ...(details ? ["--details", "-"] : [])], details);
const parse = (stdout) => JSON.parse(stdout.replace(/^```json\n/, "").replace(/\n```\n?$/, ""));
const branch = (dir) => git(dir, "rev-parse", "--abbrev-ref", "HEAD");

/** The state `verify.ts` leaves behind, for the current head. */
function verified(dir, overrides = {}) {
  write(
    dir,
    ".claude/state/last-verify.json",
    JSON.stringify({
      at: "2026-11-26T10:00:00.000Z",
      branch: branch(dir),
      commit: git(dir, "rev-parse", "--short", "HEAD"),
      dirty: false,
      ok: true,
      steps: [{ name: "test", ok: true }],
      ...overrides,
    }),
  );
}

/** A first pass up to the point where the story is implemented and committed. */
function implemented(dir) {
  assert.equal(start(dir).code, 0);
  write(dir, STORY, story("in-progress"));
  git(dir, "commit", "-q", "-am", "ST-012: start");
  write(dir, "src/order.ts", "export const order = 2;\n");
  write(dir, STORY, story("in-progress", true));
  git(dir, "commit", "-q", "-am", "ST-012: extract the helper");
}

// --------------------------------------------------------------------------
// start
// --------------------------------------------------------------------------
test("start: a first pass cuts the story branch from the given base and picks nothing itself", () => {
  const dir = repo();
  const r = start(dir);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /PASS\s+first/);
  assert.match(r.out, /BRANCH\s+st-012-place-order – created from marathon\/run-1/);
  assert.equal(branch(dir), "st-012-place-order");
  assert.equal(git(dir, "rev-parse", "HEAD"), git(dir, "rev-parse", "marathon/run-1"), "no commit, no pull, no merge");
});

test("start: needs the story and the base – a worker assumes neither", () => {
  const dir = repo();
  assert.equal(worker(dir, ["start", "--base", "marathon/run-1"]).code, 2);
  assert.equal(worker(dir, ["start", "ST-012"]).code, 2);
  const missing = worker(dir, ["start", "ST-012", "--base", "origin/nowhere"]);
  assert.equal(missing.code, 1);
  assert.match(missing.out, /STOP\s+the base 'origin\/nowhere' does not exist/);
  assert.equal(branch(dir), "marathon/run-1", "nothing switched");
});

test("start: stops on uncommitted work but tolerates collected metrics", () => {
  const dir = repo();
  write(dir, "src/order.ts", "export const order = 99;\n");
  const dirty = start(dir);
  assert.equal(dirty.code, 1);
  assert.match(dirty.out, /STOP\s+the working tree has uncommitted changes \(src\/order\.ts\)/);
  assert.equal(branch(dir), "marathon/run-1");

  git(dir, "checkout", "-q", "--", "src/order.ts");
  write(dir, "docs/stories/metrics/ST-011.json", "{}\n");
  const metrics = start(dir);
  assert.equal(metrics.code, 0, metrics.out);
  assert.match(metrics.out, /METRICS\s+1 collected file/);
});

test("start: only a story that is ready on the base starts", () => {
  const dir = repo("review");
  const r = start(dir);
  assert.equal(r.code, 1);
  assert.match(r.out, /STOP\s+the story is 'review' on 'marathon\/run-1', not 'ready'/);
  assert.ok(!git(dir, "branch", "--list", "st-012-place-order"), "no branch for a story that may not start");
});

test("start: an existing branch is a continuation – it is switched to, never recreated, and the reviews are named", () => {
  const dir = repo();
  implemented(dir);
  write(dir, "docs/reviews/ST-012-code-review.md", "# Review\n\n- major: …\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "ST-012: review");
  const head = git(dir, "rev-parse", "HEAD");
  git(dir, "switch", "-q", "marathon/run-1");

  const r = start(dir);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /PASS\s+continuation/);
  assert.match(r.out, /3 commit\(s\) since marathon\/run-1/);
  assert.match(r.out, /REVIEWS\s+docs\/reviews\/ST-012-code-review\.md/);
  assert.equal(branch(dir), "st-012-place-order");
  assert.equal(git(dir, "rev-parse", "HEAD"), head, "the branch keeps its commits");

  const json = JSON.parse(start(dir, "--json").stdout);
  assert.equal(json.pass, "continuation");
  assert.equal(json.storyStatus, "in-progress");
});

// --------------------------------------------------------------------------
// report
// --------------------------------------------------------------------------
test("report: ready-for-review carries the facts from git and needs a green verify on the branch head", () => {
  const dir = repo();
  implemented(dir);

  const noVerify = report(dir, "ready-for-review", { reason: "done" });
  assert.equal(noVerify.code, 1);
  assert.match(noVerify.out, /verify\.ts has not run on this branch/);
  assert.match(noVerify.out, /blocked/);

  verified(dir, { ok: false, steps: [{ name: "test", ok: false }] });
  assert.match(report(dir, "ready-for-review", { reason: "done" }).out, /verify\.ts is red \(test\)/);

  verified(dir);
  const ok = report(dir, "ready-for-review", { reason: "Helper extracted.", newTerms: [{ term: "Order line", meaning: "One position of an order" }] });
  assert.equal(ok.code, 0, ok.out);
  const data = parse(ok.stdout);
  assert.equal(data.report, "implement-worker");
  assert.equal(data.result, "ready-for-review");
  assert.equal(data.story, "ST-012");
  assert.equal(data.base, "marathon/run-1");
  assert.equal(data.branch, "st-012-place-order");
  assert.equal(data.storyStatus, "in-progress");
  assert.deepEqual(data.commits.map((c) => c.subject), ["ST-012: start", "ST-012: extract the helper"]);
  assert.deepEqual(data.changedFiles, [STORY, "src/order.ts"]);
  assert.deepEqual(data.uncommitted, []);
  assert.equal(data.verify.status, "green");
  assert.deepEqual(data.newTerms, [{ term: "Order line", meaning: "One position of an order" }]);
  assert.deepEqual(data.openQuestions, []);
});

test("report: ready-for-review needs a story the orchestrator can set done after the merge", () => {
  const dir = repo();
  implemented(dir);
  // The last checklist item is still open: `story-status.ts done` would refuse on the integration branch.
  write(dir, STORY, story("in-progress"));
  git(dir, "commit", "-q", "-am", "ST-012: untick");
  verified(dir);
  const r = report(dir, "ready-for-review", { reason: "done" });
  assert.equal(r.code, 1);
  assert.match(r.out, /could not be set 'done' after the merge: 1 unticked acceptance criteria: "The helper is extracted"/);
  assert.equal(report(dir, "blocked", { reason: "one item cannot be met" }).code, 0);
});

test("report: a verify run goes stale with the next code change, not with a metrics commit", () => {
  const dir = repo();
  implemented(dir);
  verified(dir);

  write(dir, "docs/stories/metrics/ST-012.json", "{}\n");
  assert.match(report(dir, "ready-for-review", { reason: "done" }).out, /uncommitted changes: docs\/stories\/metrics\/ST-012\.json/);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "ST-012: metrics");
  assert.equal(report(dir, "ready-for-review", { reason: "done" }).code, 0, "metrics after the run keep it valid");

  write(dir, "src/order.ts", "export const order = 3;\n");
  git(dir, "commit", "-q", "-am", "ST-012: one more change");
  const stale = report(dir, "ready-for-review", { reason: "done" });
  assert.equal(stale.code, 1);
  assert.match(stale.out, /the code changed after the last verify\.ts run/);

  verified(dir, { dirty: true });
  assert.equal(report(dir, "ready-for-review", { reason: "done" }).code, 1, "a run on uncommitted code proves nothing about the head");
});

test("report: an open question or an open finding is blocked, never ready-for-review", () => {
  const dir = repo();
  implemented(dir);
  verified(dir);
  const question = { question: "Does a cancelled order keep its number?", kind: "domain" };

  const asReady = report(dir, "ready-for-review", { reason: "done", openQuestions: [question] });
  assert.equal(asReady.code, 1);
  assert.match(asReady.out, /an open question is a decision nobody made yet/);
  assert.match(report(dir, "ready-for-review", { reason: "done", findings: [{ finding: "No index", action: "open" }] }).out, /1 finding\(s\) are still open/);

  const blocked = report(dir, "blocked", { reason: "The story does not say what happens to the number.", openQuestions: [question] });
  assert.equal(blocked.code, 0, blocked.out);
  const data = parse(blocked.stdout);
  assert.equal(data.result, "blocked");
  assert.deepEqual(data.openQuestions, [question]);
  assert.equal(data.commits.length, 2, "the work so far is in the report");
});

test("report: blocked always works – before the branch exists and with a dirty tree – but never without a reason", () => {
  const dir = repo();
  write(dir, "src/order.ts", "export const order = 99;\n");
  assert.equal(start(dir).code, 1);

  const silent = report(dir, "blocked");
  assert.equal(silent.code, 1);
  assert.match(silent.out, /blocked needs a reason/);

  const r = report(dir, "blocked", { reason: "The working tree has uncommitted changes that are not mine." });
  assert.equal(r.code, 0, r.out);
  const data = parse(r.stdout);
  assert.equal(data.head, null);
  assert.deepEqual(data.commits, []);
  assert.deepEqual(data.uncommitted, ["src/order.ts"]);
  assert.equal(data.verify.status, "not-run");
});

test("report: returned-to-review needs the story in review and the question it has to answer", () => {
  const dir = repo();
  implemented(dir);
  const details = { reason: "The checklist contradicts ST-009.", openQuestions: [{ question: "Which rule wins?", kind: "domain" }] };

  const tooEarly = report(dir, "returned-to-review", details);
  assert.equal(tooEarly.code, 1);
  assert.match(tooEarly.out, /story-status\.ts ST-012 review/);

  write(dir, STORY, story("review"));
  git(dir, "commit", "-q", "-am", "ST-012: back to review");
  assert.match(report(dir, "returned-to-review", { reason: "The checklist contradicts ST-009." }).out, /needs the open question/);
  const r = report(dir, "returned-to-review", details);
  assert.equal(r.code, 0, r.out);
  assert.equal(parse(r.stdout).storyStatus, "review");

  // A story that went back is not continued until it is approved again.
  const again = start(dir);
  assert.equal(again.code, 1);
  assert.match(again.out, /STOP\s+the story is 'review' on st-012-place-order/);
});

test("report: malformed details are rejected instead of dropped", () => {
  const dir = repo();
  const r = report(dir, "blocked", { reason: "x", questions: [], openQuestions: [{ question: "?" , kind: "money" }], newTerms: [{ term: "A" }] });
  assert.equal(r.code, 2);
  assert.match(r.out, /unknown key 'questions'/);
  assert.match(r.out, /openQuestions\[0\]\.kind must be domain or technical/);
  assert.match(r.out, /newTerms\[0\] needs meaning/);
  assert.equal(worker(dir, ["report", "ST-012", "--base", "marathon/run-1", "--result", "done"]).code, 2);
});

// --------------------------------------------------------------------------
// pure parts
// --------------------------------------------------------------------------
test("parseDetails: nothing passed is an empty judgement", () => {
  assert.deepEqual(parseDetails(undefined), { details: { reason: "", newTerms: [], adrProposals: [], openQuestions: [], findings: [] }, errors: [] });
  assert.deepEqual(parseDetails([]).errors, ["the details must be a JSON object"]);
});

test("planStart and reportErrors decide from the facts alone", () => {
  const facts = {
    story: "ST-012", title: "T", type: "domain", storyStatus: "ready", baseStatus: "ready", base: "main", baseCommit: "abc1234",
    branch: "st-012-x", branchExists: false, current: "main", head: null, commits: [], changedFiles: [], uncommitted: [],
    verify: { status: "not-run", at: null, commit: null, failed: [] }, reviews: [], unlinked: null, doneBlockers: [],
  };
  assert.deepEqual(planStart(facts), { pass: "first", problems: [], switch: ["switch", "-c", "st-012-x", "main"] });
  assert.deepEqual(planStart({ ...facts, branchExists: true }).switch, ["switch", "st-012-x"]);
  assert.deepEqual(planStart({ ...facts, branchExists: true, current: "st-012-x" }).switch, []);
  assert.match(planStart({ ...facts, unlinked: "jira" }).problems[0], /no external key for the jira backlog/);

  const none = { reason: "", newTerms: [], adrProposals: [], openQuestions: [], findings: [] };
  const errs = reportErrors(facts, "ready-for-review", none);
  assert.ok(errs.some((e) => /not on the story branch/.test(e)));
  assert.ok(errs.some((e) => /not 'in-progress'/.test(e)));
  assert.ok(errs.some((e) => /no commit/.test(e)));
});

// --------------------------------------------------------------------------
// what a worker relies on around it
// --------------------------------------------------------------------------
test("changedPaths keeps the first unstaged file (the status columns are blanks, not padding)", () => {
  const dir = mkdtempSync(join(tmpdir(), "kataster-changed-"));
  write(dir, "a.ts", "a\n");
  write(dir, "b.ts", "b\n");
  write(dir, "old name.ts", "c\n");
  git(dir, "init", "-q");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  write(dir, "a.ts", "a2\n");
  write(dir, "b.ts", "b2\n");
  write(dir, "new.ts", "n\n");
  git(dir, "mv", "old name.ts", "new name.ts");
  assert.deepEqual(changedPaths(dir).sort(), ["a.ts", "b.ts", "new name.ts", "new.ts"]);
});

test("path-guard --deny blocks the listed paths and nothing else", () => {
  const dir = repo();
  const guard = (file) =>
    spawnSync(process.execPath, [join(dir, ".claude", "hooks", "path-guard.ts"), "--deny", "CONTEXT.md", "docs/adr/", "docs/reviews/"], {
      cwd: dir,
      encoding: "utf8",
      input: JSON.stringify({ tool_name: "Write", tool_input: { file_path: file }, cwd: dir }),
    });
  assert.equal(guard("src/order.ts").status, 0);
  assert.equal(guard(STORY).status, 0);
  assert.equal(guard("CONTEXT.md").status, 2);
  assert.equal(guard(join(dir, "docs/adr/0007-clock.md")).status, 2);
  assert.match(guard("docs/reviews/ST-012-code-review.md").stderr, /may not write 'docs\/reviews\/ST-012-code-review\.md'/);
  // the allow-list form is unchanged
  const allow = spawnSync(process.execPath, [join(dir, ".claude", "hooks", "path-guard.ts"), "docs/reviews/"], {
    cwd: dir,
    encoding: "utf8",
    input: JSON.stringify({ tool_name: "Write", tool_input: { file_path: "src/order.ts" }, cwd: dir }),
  });
  assert.equal(allow.status, 2);
});

test("both harnesses ship the same worker: one skill text, one agent, no way to start a subagent", () => {
  const dir = repo();
  const read = (path) => readFileSync(join(dir, path), "utf8");
  for (const file of [".claude/agents/story-worker.md", ".opencode/agents/story-worker.md", ".claude/skills/implement/scripts/worker.ts", ".claude/lib/worker.ts"]) {
    assert.ok(existsSync(join(dir, file)), `${file} is installed`);
  }
  const claude = read(".claude/agents/story-worker.md");
  const opencode = read(".opencode/agents/story-worker.md");
  assert.match(claude, /^disallowedTools:.*\bAgent\b/m, "Claude Code: the worker has no Agent tool");
  assert.match(opencode, /action: subagent\n\s+resource: "\*"\n\s+effect: deny/, "OpenCode: the worker may not start a subagent");
  assert.match(opencode, /action: question\n\s+resource: "\*"\n\s+effect: deny/);
  // The instructions after the frontmatter differ only in how the harness loads the skill.
  const body = (text) => text.slice(text.indexOf("\n---", 4) + 4).split("\n").filter((line) => !/^1\. /.test(line) && !line.includes("the harness blocks")).join("\n");
  assert.equal(body(claude), body(opencode));

  const skill = read(".claude/skills/implement/SKILL.md");
  assert.match(skill, /^## Worker mode \(`--worker ST-NNN --base <branch>`\)$/m);
  assert.match(skill, /worker\.ts start ST-NNN --base <branch>/);
  assert.match(skill, /worker\.ts report ST-NNN --base <branch> --result <result>/);
  const command = read(".opencode/commands/implement.md");
  assert.match(command, /--worker/);
  assert.match(command, /starts no subagent/);
  assert.match(command, /\$ARGUMENTS/);
});
