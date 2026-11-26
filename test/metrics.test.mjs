import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cli = resolve(here, "..", "bin", "kataster.mjs");
const fixtures = join(here, "fixtures", "metrics");
const yamlSource = resolve(here, "..", ".claude", "node_modules", "yaml");

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "kataster-metrics-"));
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

/** Copies the Claude Code fixture (main transcript + subagents) into the repo and returns the transcript path. */
function claudeTranscript(dir) {
  const target = join(dir, "transcripts");
  cpSync(join(fixtures, "claude"), target, { recursive: true });
  return join(target, "sess-1.jsonl");
}

/** Builds an OpenCode database from a SQL fixture. */
function openCodeDb(dir, fixture) {
  const path = join(dir, "opencode.db");
  const db = new DatabaseSync(path);
  db.exec(readFileSync(join(fixtures, fixture), "utf8"));
  db.close();
  return path;
}

function metrics(dir, args, env = {}) {
  const r = spawnSync(process.execPath, [join(dir, ".claude", "skills", "metrics", "scripts", "story-metrics.ts"), ...args], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, KATASTER_METRICS_STATE: join(dir, "state"), KATASTER_OPENCODE_DB: join(dir, "opencode.db"), ...env },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}`, stdout: r.stdout };
}

function hook(dir, payload, env = {}) {
  const r = spawnSync(process.execPath, [join(dir, ".claude", "hooks", "metrics.ts")], {
    cwd: dir,
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, KATASTER_METRICS_STATE: join(dir, "state"), ...env },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** A marker as the hook would complete it, at a fixed time. */
const mark = (dir, at, target, phase, edge, identity) => metrics(dir, ["mark", target, phase, edge, ...identity], { KATASTER_METRICS_NOW: at });

const entriesOf = (dir, file) => JSON.parse(readFileSync(join(dir, "docs", "stories", "metrics", file), "utf8")).entries;
const tokens = (input, output, reasoning, cacheRead, cacheWrite, cacheWrite1h) => ({ input, output, reasoning, cacheRead, cacheWrite, cacheWrite1h });

// ---------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------
test("claude: a pass counts each response once, includes its subagent, and splits agent time from the question", () => {
  const dir = repo();
  const transcript = claudeTranscript(dir);
  const id = ["--harness", "claude-code", "--session", "sess-1", "--transcript", transcript];

  assert.equal(mark(dir, "2026-11-20T10:00:06.000Z", "ST-001", "implementierung", "start", id).code, 0);
  const end = mark(dir, "2026-11-20T10:03:01.000Z", "ST-001", "implementierung", "end", id);
  assert.equal(end.code, 0, end.out);
  assert.match(end.out, /2 entries appended/);

  const [main, sub] = entriesOf(dir, "ST-001.json");
  // msg_B, msg_C, msg_D – msg_A came before the start, msg_E after the end
  assert.deepEqual(main.tokens, tokens(7, 230, 0, 8100, 0, 0));
  assert.equal(main.messages, 3);
  assert.equal(main.harness, "claude-code");
  assert.equal(main.model, "claude-opus-5-5");
  assert.equal(main.agent, "main");
  // 175 s wall time, 120 s of it waiting for the AskUserQuestion answer
  assert.equal(main.userWaitMs, 120_000);
  assert.equal(main.agentMs, 55_000);
  assert.equal(main.costUsd, undefined, "cost is never stored");

  // the unmarked code-reviewer subagent inherits the open phase of its parent
  assert.equal(sub.agent, "a1");
  assert.equal(sub.agentType, "code-reviewer");
  assert.equal(sub.model, "claude-haiku-5-5");
  assert.deepEqual(sub.tokens, tokens(5, 80, 0, 700, 100, 0));
  assert.equal(sub.agentMs, 19_000);
  assert.equal(sub.userWaitMs, 0);

  // a second end has nothing to close
  assert.match(mark(dir, "2026-11-20T10:03:02.000Z", "ST-001", "implementierung", "end", id).out, /no open start/);
});

test("claude: finalising a session writes the unassigned pot once – thinking stays inside output", () => {
  const dir = repo();
  const transcript = claudeTranscript(dir);
  const id = ["--harness", "claude-code", "--session", "sess-1", "--transcript", transcript];
  mark(dir, "2026-11-20T10:00:06.000Z", "ST-001", "implementierung", "start", id);
  mark(dir, "2026-11-20T10:03:01.000Z", "ST-001", "implementierung", "end", id);

  const collected = metrics(dir, ["collect", "--session", "sess-1"]);
  assert.equal(collected.code, 0, collected.out);
  const pot = entriesOf(dir, "ST-001.json").filter((e) => e.phase === "unassigned");
  assert.equal(pot.length, 1);
  // msg_A (two lines, one response: 100 output incl. 40 thinking), msg_E, msg_F; the <synthetic> line is ignored
  assert.deepEqual(pot[0].tokens, tokens(12, 112, 40, 7500, 500, 500));
  assert.equal(pot[0].messages, 3);
  // outside the pass: 6 s before it, 425 s after it – of which 409 s waiting for the next prompt
  assert.equal(pot[0].userWaitMs, 409_000);
  assert.equal(pot[0].agentMs, 22_000);

  // idempotent: a second collect adds nothing
  metrics(dir, ["collect", "--session", "sess-1"]);
  assert.equal(entriesOf(dir, "ST-001.json").length, 3);
});

test("collect --since: the end of a marathon run takes its sessions, idle or not – and only once", () => {
  const dir = repo();
  const transcript = claudeTranscript(dir);
  const id = ["--harness", "claude-code", "--session", "sess-1", "--transcript", transcript];
  mark(dir, "2026-11-20T10:00:06.000Z", "ST-001", "implementierung", "start", id);
  mark(dir, "2026-11-20T10:03:01.000Z", "ST-001", "implementierung", "end", id);

  // The session counts as active (idle limit far away): the stale sweep leaves it alone.
  assert.match(metrics(dir, ["collect", "--idle-minutes", "100000000"]).out, /Nothing to collect/);
  // A run that started after the markers does not own this session.
  assert.match(metrics(dir, ["collect", "--since", "2026-11-21T00:00:00Z"]).out, /Nothing to collect/);
  const r = metrics(dir, ["collect", "--since", "2026-11-20T10:00:00Z"]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /ST-001 unassigned: 1 entry/);
  assert.equal(entriesOf(dir, "ST-001.json").filter((e) => e.phase === "unassigned").length, 1);
  metrics(dir, ["collect", "--since", "2026-11-20T10:00:00Z"]);
  assert.equal(entriesOf(dir, "ST-001.json").filter((e) => e.phase === "unassigned").length, 1, "nothing twice");
  assert.equal(metrics(dir, ["collect", "--since", "yesterday"]).code, 2);
});

test("claude: parallel reviewers – a subagent counts towards the review phase of its own type", () => {
  const dir = repo();
  const transcript = claudeTranscript(dir);
  const id = ["--harness", "claude-code", "--session", "sess-1", "--transcript", transcript];
  mark(dir, "2026-11-20T10:00:15.000Z", "ST-001", "review-code-reviewer", "start", id);
  mark(dir, "2026-11-20T10:00:16.000Z", "ST-001", "review-acceptance-tester", "start", id);
  mark(dir, "2026-11-20T10:00:46.000Z", "ST-001", "review-code-reviewer", "end", id);
  mark(dir, "2026-11-20T10:00:47.000Z", "ST-001", "review-acceptance-tester", "end", id);

  const entries = entriesOf(dir, "ST-001.json");
  const reviewer = entries.find((e) => e.agent === "a1");
  assert.equal(reviewer.phase, "review-code-reviewer", "the later-started acceptance phase must not take the code-reviewer");
  const mainB = entries.find((e) => e.agent === "main" && e.messages > 0);
  assert.equal(mainB.phase, "review-acceptance-tester", "the main session's own message goes to the latest open phase");
  // the code-reviewer pass still carries its owner's time, on a token-less row
  const ownerTime = entries.find((e) => e.agent === "main" && e.phase === "review-code-reviewer");
  assert.equal(ownerTime.model, null);
  assert.equal(ownerTime.agentMs, 31_000);
});

test("claude: a permission prompt logged by the hook counts as waiting in the subagent that asked", () => {
  const dir = repo();
  const transcript = claudeTranscript(dir);
  const asked = hook(dir, { hook_event_name: "PermissionRequest", session_id: "sess-1", agent_id: "a1", tool_use_id: "toolu_p1", tool_name: "Bash" }, { KATASTER_METRICS_NOW: "2026-11-20T10:00:22.000Z" });
  assert.equal(asked.code, 0);
  const id = ["--harness", "claude-code", "--session", "sess-1", "--transcript", transcript];
  mark(dir, "2026-11-20T10:00:06.000Z", "ST-001", "implementierung", "start", id);
  mark(dir, "2026-11-20T10:03:01.000Z", "ST-001", "implementierung", "end", id);
  const sub = entriesOf(dir, "ST-001.json").find((e) => e.agent === "a1");
  // asked at :22, the subagent's next transcript line is at :30
  assert.equal(sub.userWaitMs, 8_000);
  assert.equal(sub.agentMs, 11_000);
});

test("claude: a marker without the hook's identity records time only", () => {
  const dir = repo();
  mark(dir, "2026-11-20T10:00:00.000Z", "ST-004", "verify", "start", []);
  const end = mark(dir, "2026-11-20T10:01:30.000Z", "ST-004", "verify", "end", []);
  assert.equal(end.code, 0, end.out);
  const [entry] = entriesOf(dir, "ST-004.json");
  assert.equal(entry.harness, "unknown");
  assert.equal(entry.model, null);
  assert.equal(entry.agentMs, 90_000);
  assert.deepEqual(entry.tokens, tokens(0, 0, 0, 0, 0, 0));
});

test("mark: refuses unknown targets and phases", () => {
  const dir = repo();
  assert.equal(metrics(dir, ["mark", "ST-1", "verify", "start"]).code, 2);
  assert.equal(metrics(dir, ["mark", "ST-001", "coding", "start"]).code, 2);
  assert.equal(metrics(dir, ["mark", "feature:Order Photos", "grilling", "start"]).code, 2);
  assert.equal(metrics(dir, ["mark", "ST-001", "verify", "begin"]).code, 2);
  assert.equal(metrics(dir, ["mark", "ST-001", "unassigned", "start"]).code, 2);
  assert.equal(metrics(dir, ["mark", "st-001", "review-code-reviewer", "start"]).code, 0);
});

// ---------------------------------------------------------------------------
// The hook
// ---------------------------------------------------------------------------
test("hook: PreToolUse inserts the caller's identity right after `mark` – main session, subagent, OpenCode", () => {
  const dir = repo();
  const cmd = "node .claude/skills/metrics/scripts/story-metrics.ts mark ST-001 verify start && echo ok";
  const main = JSON.parse(hook(dir, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: cmd, description: "d" }, session_id: "s1", transcript_path: "/tmp/it's here.jsonl" }).stdout);
  const updated = main.hookSpecificOutput.updatedInput;
  assert.equal(updated.description, "d", "other tool input stays");
  assert.equal(
    updated.command,
    "node .claude/skills/metrics/scripts/story-metrics.ts mark --harness claude-code --session 's1' --transcript '/tmp/it'\\''s here.jsonl' ST-001 verify start && echo ok",
  );
  assert.equal(main.hookSpecificOutput.permissionDecision, undefined, "the permission decision stays with the harness");

  const sub = JSON.parse(hook(dir, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: cmd }, session_id: "s1", agent_id: "a9", agent_type: "worker" }).stdout);
  assert.match(sub.hookSpecificOutput.updatedInput.command, /mark --harness claude-code --session 's1' --agent 'a9' --agent-type 'worker' ST-001/);

  const oc = JSON.parse(hook(dir, { hook_event_name: "PreToolUse", harness: "opencode", tool_name: "Bash", tool_input: { command: cmd }, session_id: "ses_x", agent_type: "build" }).stdout);
  assert.match(oc.hookSpecificOutput.updatedInput.command, /mark --harness opencode --session 'ses_x' --agent-type 'build' ST-001/);

  // not a mark call, or already completed → no output at all
  assert.equal(hook(dir, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git status" }, session_id: "s1" }).stdout, "");
  assert.equal(hook(dir, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: `${cmd.replace("mark", "mark --session x")}` }, session_id: "s1" }).stdout, "");
  // text that only mentions a mark call is never changed: heredoc, echo, a node -e script, or mixed with a real call
  const mention = "node .claude/skills/metrics/scripts/story-metrics.ts mark ST-001 verify start";
  for (const command of [
    `cat > notes.md <<'EOF'\n${mention}\nEOF`,
    `echo "${mention}"`,
    `node -e 'console.log("${mention}")'`,
    `cat > notes.md <<'EOF'\n${mention}\nEOF\n${mention}`,
  ]) {
    assert.equal(hook(dir, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, session_id: "s1" }).stdout, "", command);
  }
  // two real calls in one command both get the identity
  const two = JSON.parse(hook(dir, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: `${mention.replace("start", "end")} && ${mention.replace("verify", "fixes")}` }, session_id: "s1" }).stdout);
  assert.equal((two.hookSpecificOutput.updatedInput.command.match(/--session 's1'/g) ?? []).length, 2);
  // broken input never fails the tool call
  const r = spawnSync(process.execPath, [join(dir, ".claude", "hooks", "metrics.ts")], { input: "{", encoding: "utf8" });
  assert.equal(r.status, 0);
});

test("hook: OpenCode permission and form events become wait events", () => {
  const dir = repo();
  hook(dir, { hook_event_name: "KatasterEvent", harness: "opencode", type: "permission.asked", data: { id: "per_1", sessionID: "ses_root" } });
  hook(dir, { hook_event_name: "KatasterEvent", harness: "opencode", type: "permission.replied", data: { requestID: "per_1", sessionID: "ses_root", reply: "once" } });
  hook(dir, { hook_event_name: "KatasterEvent", harness: "opencode", type: "form.created", data: { form: { id: "frm_1", sessionID: "ses_root" } } });
  hook(dir, { hook_event_name: "KatasterEvent", harness: "opencode", type: "form.replied", data: { id: "frm_1" } });
  const events = readFileSync(join(dir, "state", "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(events.map((e) => `${e.kind}:${e.id}:${e.session}`), [
    "permission.asked:per_1:ses_root",
    "permission.replied:per_1:ses_root",
    "question.asked:frm_1:ses_root",
    "question.replied:frm_1:",
  ]);
});

// ---------------------------------------------------------------------------
// OpenCode
// ---------------------------------------------------------------------------
test("opencode: v2 database – reasoning folded into output, a child session with its own markers, idle and question waits", () => {
  const dir = repo();
  openCodeDb(dir, "opencode-v2.sql");
  const root = ["--harness", "opencode", "--session", "ses_root", "--agent-type", "build"];
  const child = ["--harness", "opencode", "--session", "ses_child", "--agent-type", "code-reviewer"];
  mark(dir, "2026-11-20T11:00:12.000Z", "ST-002", "implementierung", "start", root);
  mark(dir, "2026-11-20T11:00:33.000Z", "ST-002", "review-code-reviewer", "start", child);
  const childEnd = mark(dir, "2026-11-20T11:00:45.000Z", "ST-002", "review-code-reviewer", "end", child);
  assert.equal(childEnd.code, 0, childEnd.out);
  const end = mark(dir, "2026-11-20T11:03:20.000Z", "ST-002", "implementierung", "end", root);
  assert.equal(end.code, 0, end.out);

  const entries = entriesOf(dir, "ST-002.json");
  const review = entries.find((e) => e.phase === "review-code-reviewer");
  assert.equal(review.harness, "opencode");
  assert.equal(review.agent, "ses_child");
  assert.equal(review.agentType, "code-reviewer");
  assert.equal(review.run, "ses_root");
  assert.equal(review.model, "deepseek-v4.1-flash");
  assert.equal(review.provider, "opencode-go");
  // output 10 + reasoning 5 → 15, reasoning kept as its breakdown
  assert.deepEqual(review.tokens, tokens(20, 15, 5, 500, 0, 0));
  assert.equal(review.harnessCostUsd, 0.001);
  assert.equal(review.agentMs, 12_000);

  const impl = entries.find((e) => e.phase === "implementierung");
  assert.equal(impl.agent, "main");
  // m3 and m9 – the marked child session keeps its own message
  assert.deepEqual(impl.tokens, tokens(11, 6, 0, 4100, 0, 0));
  assert.equal(impl.harnessCostUsd, 0.002);
  // 188 s wall: idle → next prompt 120 s, the question tool 4 s
  assert.equal(impl.userWaitMs, 124_000);
  assert.equal(impl.agentMs, 64_000);
});

test("opencode: falls back to the legacy tables", () => {
  const dir = repo();
  openCodeDb(dir, "opencode-v1.sql");
  const id = ["--harness", "opencode", "--session", "ses_old"];
  mark(dir, "2026-11-20T11:00:01.000Z", "ST-003", "verify", "start", id);
  const end = mark(dir, "2026-11-20T11:00:10.000Z", "ST-003", "verify", "end", id);
  assert.equal(end.code, 0, end.out);
  const [entry] = entriesOf(dir, "ST-003.json");
  assert.equal(entry.model, "qwen3.6-plus");
  assert.deepEqual(entry.tokens, tokens(30, 250, 0, 1000, 31, 0));
  assert.equal(entry.harnessCostUsd, 0.007);
});

test("opencode: an unknown schema is reported clearly and the marker still records time", () => {
  const dir = repo();
  const db = new DatabaseSync(join(dir, "opencode.db"));
  db.exec("CREATE TABLE sessions (id text PRIMARY KEY); CREATE TABLE message (id text PRIMARY KEY, data text);");
  db.close();
  const id = ["--harness", "opencode", "--session", "ses_x"];
  mark(dir, "2026-11-20T11:00:00.000Z", "ST-005", "verify", "start", id);
  const end = mark(dir, "2026-11-20T11:00:30.000Z", "ST-005", "verify", "end", id);
  assert.equal(end.code, 0, end.out);
  assert.match(end.out, /unknown schema/);
  assert.match(end.out, /missing: table session_v2/);
  assert.match(end.out, /message\.session_id/);
  const [entry] = entriesOf(dir, "ST-005.json");
  assert.equal(entry.agentMs, 30_000);
  assert.equal(entry.messages, 0);
});

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
function entry(target, phase, model, toks, extra = {}) {
  return {
    key: `${target}|${phase}|${model}|${extra.start ?? "2026-11-20T10:00:00.000Z"}`,
    target, phase, harness: "claude-code", run: "r1", session: "r1", agent: "main", agentType: "main",
    model, provider: null, start: "2026-11-20T10:00:00.000Z", end: "2026-11-20T10:10:00.000Z", messages: 1,
    tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, ...toks },
    harnessCostUsd: null, agentMs: 60_000, userWaitMs: 0, recorded: "2026-11-20T10:10:00.000Z", ...extra,
  };
}
const metricsFile = (target, entries) => `${JSON.stringify({ version: 1, target, entries })}\n`;

function reportRepo() {
  const dir = repo();
  const profile = JSON.parse(readFileSync(join(dir, ".claude", "project.json"), "utf8"));
  profile.metrics = { prices: { m1: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 } } };
  write(dir, ".claude/project.json", JSON.stringify(profile, null, 2));
  write(dir, "docs/stories/ST-001-place-order.md", `---
id: ST-001
title: Place an order
type: domain
priority: should
size: S
feature: demo
labels: [feature:demo]
status: ready
---

## Acceptance Criteria

Scenario: Placed
  Given a cart
  When the customer places it
  Then the order exists

Scenario: Empty cart
  Given an empty cart
  When the customer places it
  Then it is rejected
`);
  write(dir, "docs/stories/ST-002-tidy-up.md", `---
id: ST-002
title: Tidy up the order list
type: chore
priority: should
size: M
feature: demo
status: ready
---

## Task
Tidy.

## Acceptance Criteria
- [ ] one
- [ ] two
- [ ] three
`);
  write(dir, "docs/stories/metrics/feature-demo.json", metricsFile("feature:demo", [entry("feature:demo", "grilling", "m1", { input: 1_000_000 }, { start: "2026-10-01T10:00:00.000Z" })]));
  write(dir, "docs/stories/metrics/ST-001.json", metricsFile("ST-001", [
    entry("ST-001", "implementierung", "m1", { input: 1_000_000, output: 1_000_000 }),
    entry("ST-001", "unassigned", "m1", { cacheRead: 1_000_000 }),
  ]));
  write(dir, "docs/stories/metrics/ST-002.json", metricsFile("ST-002", [entry("ST-002", "implementierung", "mystery", { input: 1000 })]));
  return dir;
}

test("report: prices from the profile, spec share by scenarios/checklist, unknown models, size vs. actual", () => {
  const dir = reportRepo();
  const r = metrics(dir, ["report", "--json"]);
  assert.equal(r.code, 0, r.out);
  const data = JSON.parse(r.stdout);
  const st1 = data.stories.find((s) => s.id === "ST-001");
  const st2 = data.stories.find((s) => s.id === "ST-002");
  assert.equal(st1.own.costUsd, 3); // 1M input × $1 + 1M output × $2
  assert.ok(Math.abs(st1.unassigned.costUsd - 0.1) < 1e-9);
  // feature: $1, weights 2 scenarios : 3 checklist items
  assert.ok(Math.abs(st1.spec.costUsd - 0.4) < 1e-9);
  assert.ok(Math.abs(st1.total.costUsd - 3.5) < 1e-9);
  assert.equal(st2.own.costUsd, null, "a model without a price has no cost");
  assert.ok(Math.abs(st2.spec.costUsd - 0.6) < 1e-9);
  assert.equal(data.features[0].key, "scenarios/checklist");
  assert.ok(data.warnings.some((w) => /no price .* mystery/.test(w)));
  assert.deepEqual(data.sizes.map((s) => [s.size, s.stories, s.meanCost === null ? null : Math.round(s.meanCost * 100) / 100]), [["S", 1, 3.5], ["M", 1, null]]);

  const story = metrics(dir, ["report", "--story", "ST-001"]);
  assert.match(story.stdout, /spec share \(feature:demo, scenarios\/checklist, 40%\)/);
  assert.match(story.stdout, /\| total .*\$3\.50/);
  assert.match(story.stdout, /\| unassigned /);

  const overview = metrics(dir, ["report"]);
  assert.match(overview.stdout, /## Size vs\. actual/);
  assert.match(overview.stdout, /feature:demo/);
});

test("report: equal split when a story has no weight; --since leaves older entries out", () => {
  const dir = reportRepo();
  write(dir, "docs/stories/ST-002-tidy-up.md", readFileSync(join(dir, "docs/stories/ST-002-tidy-up.md"), "utf8").replace(/- \[ \] .*\n/g, ""));
  const equal = JSON.parse(metrics(dir, ["report", "--json"]).stdout);
  assert.equal(equal.features[0].key, "equal");
  assert.ok(Math.abs(equal.stories.find((s) => s.id === "ST-001").spec.costUsd - 0.5) < 1e-9);

  const since = JSON.parse(metrics(dir, ["report", "--since", "2026-11-01", "--json"]).stdout);
  assert.equal(since.features.length, 0);
  assert.equal(since.stories.find((s) => s.id === "ST-001").spec.costUsd, 0);

  const feature = metrics(dir, ["report", "--feature", "demo"]);
  assert.match(feature.stdout, /\| grilling /);
  assert.match(feature.stdout, /\| ST-001 \| +2 \| +50% \|/);
  assert.equal(metrics(dir, ["report", "--since", "yesterday"]).code, 1);
});

test("report: an invalid price table is a warning, not a crash", () => {
  const dir = reportRepo();
  const profile = JSON.parse(readFileSync(join(dir, ".claude", "project.json"), "utf8"));
  profile.metrics.prices.m1 = { input: "1", output: 2, cached: 3 };
  write(dir, ".claude/project.json", JSON.stringify(profile));
  const data = JSON.parse(metrics(dir, ["report", "--json"]).stdout);
  assert.ok(data.warnings.some((w) => /metrics\.prices\["m1"\]: input .*unknown field 'cached'/.test(w)));
  assert.equal(data.stories.find((s) => s.id === "ST-001").own.costUsd, null);
});

// ---------------------------------------------------------------------------
// Story link and protection
// ---------------------------------------------------------------------------
test("lint: the feature field must agree with the feature label", () => {
  const dir = repo();
  const story = (extra) => `---
id: ST-001
title: Tidy up the list
type: chore
priority: should
${extra}
status: draft
---

## Task
Tidy.

## Acceptance Criteria
- [ ] done
`;
  const lint = () => spawnSync(process.execPath, [join(dir, ".claude", "skills", "user-stories", "scripts", "lint-story.ts"), "ST-001"], { cwd: dir, encoding: "utf8" });
  write(dir, "docs/stories/ST-001-tidy.md", story("feature: demo\nlabels: [feature:demo]"));
  assert.equal(lint().status, 0);
  write(dir, "docs/stories/ST-001-tidy.md", story("feature: demo\nlabels: [feature:other]"));
  let r = lint();
  assert.notEqual(r.status, 0);
  assert.match(`${r.stdout}${r.stderr}`, /feature 'demo' does not match the label 'feature:other'/);
  write(dir, "docs/stories/ST-001-tidy.md", story("labels: [feature:a, feature:b]"));
  r = lint();
  assert.match(`${r.stdout}${r.stderr}`, /more than one feature label/);
  write(dir, "docs/stories/ST-001-tidy.md", story("labels: [feature:demo]"));
  r = lint();
  assert.match(`${r.stdout}${r.stderr}`, /without the field – add 'feature: demo'/);
  write(dir, "docs/stories/ST-001-tidy.md", story("feature: Not A Slug"));
  assert.notEqual(lint().status, 0);
});

test("protect-files: metrics files are append-only", () => {
  const dir = repo();
  const r = spawnSync(process.execPath, [join(dir, ".claude", "hooks", "protect-files.ts")], {
    cwd: dir,
    input: JSON.stringify({ tool_name: "Write", tool_input: { file_path: join(dir, "docs/stories/metrics/ST-001.json"), content: "{}" }, cwd: dir }),
    encoding: "utf8",
  });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /append-only metrics file/);
});

test("install: the metrics hooks and the script permission are wired", () => {
  const dir = repo();
  const settings = JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf8"));
  const commands = (event) => (settings.hooks[event] ?? []).flatMap((e) => e.hooks.map((h) => h.command));
  for (const event of ["SessionStart", "PreToolUse", "PermissionRequest", "SessionEnd"]) {
    assert.ok(commands(event).some((c) => c.includes("hooks/metrics.ts")), event);
  }
  assert.ok(settings.permissions.allow.includes("Bash(node .claude/skills/metrics/scripts/*)"));
  assert.ok(existsSync(join(dir, ".claude", "skills", "metrics", "SKILL.md")));
});
