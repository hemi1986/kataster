import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  callerOf, emptyLease, isScheduling, isSuperseded, orchestratorError, supersedeWorker, takeOrchestrator, takeWorker, workerError,
} from "../.claude/lib/lease.ts";
import { applyClaim, applyResume, applyReview, mergeErrors, newRun, orphanAction, renderSummary, reportCovers } from "../.claude/lib/marathon.ts";

const here = dirname(fileURLToPath(import.meta.url));
const hooks = resolve(here, "..", ".claude", "hooks");
const T0 = "2026-11-26T12:00:00.000Z";
const T1 = "2026-11-26T12:30:00.000Z";
const RUN = "2026-11-26";

// --------------------------------------------------------------------------
// The lease – pure
// --------------------------------------------------------------------------
test("callerOf: the subagent in Claude Code, the (child) session in OpenCode; nothing without an id", () => {
  assert.equal(callerOf({ session_id: "s1" }), "claude-code:s1");
  assert.equal(callerOf({ session_id: "s1", agent_id: "a7" }), "claude-code:a7");
  assert.equal(callerOf({ session_id: "ses_child", harness: "opencode" }), "opencode:ses_child");
  assert.equal(callerOf({}), null);
});

test("orchestrator: the newest session takes the run over, the one before it is superseded and refused", () => {
  let lease = takeOrchestrator(null, RUN, "opencode:a", T0);
  assert.deepEqual(lease.orchestrator, { caller: "opencode:a", since: T0 });
  assert.equal(orchestratorError(lease, RUN, "opencode:a"), null);
  assert.match(orchestratorError(lease, RUN, "opencode:b"), /opencode:a is the orchestrator of run 2026-11-26 since .* only one session runs a marathon/);
  assert.equal(orchestratorError(lease, RUN, null), null, "a person in a terminal is not checked");

  lease = takeOrchestrator(lease, RUN, "opencode:b", T1);
  assert.deepEqual(lease.orchestrator, { caller: "opencode:b", since: T1 });
  assert.deepEqual(isSuperseded(lease, "opencode:a"), { caller: "opencode:a", role: "orchestrator", at: T1, by: "opencode:b" });
  assert.match(orchestratorError(lease, RUN, "opencode:a"), /was replaced as the orchestrator of run 2026-11-26 .* Stop now/);
  assert.equal(orchestratorError(lease, RUN, "opencode:b"), null);

  // Taking it again is a no-op; a lease of another run counts as none.
  assert.deepEqual(takeOrchestrator(lease, RUN, "opencode:b", "2026-11-26T13:00:00.000Z"), lease);
  assert.deepEqual(takeOrchestrator(lease, "2026-11-27", "opencode:c", T1).superseded, []);
  assert.equal(orchestratorError(lease, "2026-11-27", "opencode:a"), null);
});

test("worker: the newest worker of a story wins – the one before it is superseded, its report refused", () => {
  let { lease, replaced } = takeWorker(emptyLease(RUN), RUN, "ST-001", 1, "opencode:w1", T0);
  assert.equal(replaced, null);
  assert.deepEqual(lease.worker, { story: "ST-001", pass: 1, caller: "opencode:w1", since: T0 });
  assert.equal(workerError(lease, RUN, "ST-001", "opencode:w1"), null);

  // The same worker continues with the next pass (Claude Code's SendMessage, OpenCode's sessionID): nothing is replaced.
  ({ lease, replaced } = takeWorker(lease, RUN, "ST-001", 2, "opencode:w1", T1));
  assert.equal(replaced, null);
  assert.deepEqual(lease.worker, { story: "ST-001", pass: 2, caller: "opencode:w1", since: T0 });

  ({ lease, replaced } = takeWorker(lease, RUN, "ST-001", 3, "opencode:w2", T1));
  assert.deepEqual(replaced, { story: "ST-001", pass: 2, caller: "opencode:w1", since: T0 });
  assert.equal(isSuperseded(lease, "opencode:w1").role, "worker");
  assert.match(workerError(lease, RUN, "ST-001", "opencode:w1"), /this worker was replaced at .* another worker builds ST-001 now/);
  assert.match(workerError(lease, RUN, "ST-001", "opencode:x"), /opencode:w2 is the worker of ST-001 \(pass 3\) – this session is not/);
  assert.equal(workerError(lease, RUN, "ST-001", "opencode:w2"), null);
});

test("resume supersedes the worker of a continued claim at once – a live orphan is stopped before the next worker starts", () => {
  const { lease } = takeWorker(takeOrchestrator(null, RUN, "opencode:a", T0), RUN, "ST-001", 1, "opencode:w1", T0);
  const next = supersedeWorker(takeOrchestrator(lease, RUN, "opencode:b", T1), RUN, "ST-001", "opencode:b", T1);
  assert.equal(next.worker, null);
  assert.deepEqual(next.superseded.map((s) => [s.caller, s.role]), [["opencode:a", "orchestrator"], ["opencode:w1", "worker"]]);
  assert.deepEqual(supersedeWorker(next, RUN, "ST-002", "opencode:b", T1), next, "another story's worker is not touched");
});

test("isScheduling: cron, triggers, wakeups and automations – also from a Code Mode script – but not reading them", () => {
  for (const tool of ["CronCreate", "RemoteTrigger", "ScheduleWakeup", "automation", "automation.create"]) assert.equal(isScheduling(tool, {}), true, tool);
  assert.equal(isScheduling("execute", { code: "await tools.automation.create({ shell: 'git push' })" }), true);
  assert.equal(isScheduling("execute", { code: "return await tools.automation.list({})" }), false);
  assert.equal(isScheduling("automation.list", {}), false);
  for (const tool of ["Bash", "Write", "Agent"]) assert.equal(isScheduling(tool, { command: "echo automation.create" }), false, tool);
});

// --------------------------------------------------------------------------
// Resume, merge and summary – pure
// --------------------------------------------------------------------------
const run = () => newRun({ run: RUN, branch: `marathon/${RUN}`, base: "main", now: T0 });
const claim = (type = "domain") => applyClaim(run(), { id: "ST-001", branch: "st-001-demo", type }, T0);

test("resume: a pass that handed in its report is read, not run again – only a later commit makes the report stale", () => {
  const state = claim();
  const c = state.claims["ST-001"];
  const kept = { run: RUN, story: "ST-001", pass: 1, caller: "claude-code:a7", at: T0, head: "abc1234", result: "blocked", report: {} };
  assert.equal(reportCovers(kept, RUN, c, "abc1234"), true);
  assert.equal(reportCovers(kept, RUN, c, "def5678"), false, "a commit after the report");
  assert.equal(reportCovers({ ...kept, pass: 0 }, RUN, c, "abc1234"), false, "the report of an earlier pass");
  assert.equal(reportCovers({ ...kept, run: "2026-11-25" }, RUN, c, "abc1234"), false);
  assert.equal(reportCovers(null, RUN, c, "abc1234"), false);

  assert.equal(orphanAction(c, { branchExists: true, merged: false, reported: true }, false), "report");
  assert.equal(orphanAction(c, { branchExists: true, merged: false, reported: false }, false), "continue");
  assert.equal(orphanAction({ ...c, phase: "merge" }, { branchExists: true, merged: false, reported: true }, false), "merge");

  const read = applyResume(state, { "ST-001": { branchExists: true, merged: false, reported: true } }, [], T1);
  assert.deepEqual(read.actions, [{ story: "ST-001", action: "report", branch: "st-001-demo", attempts: 1 }]);
  assert.deepEqual(read.state.claims["ST-001"], c, "the claim stays as it is – no pass is counted");

  const cont = applyResume(state, { "ST-001": { branchExists: true, merged: false } }, [], T1);
  assert.deepEqual([cont.state.claims["ST-001"].attempts, cont.state.claims["ST-001"].resumed], [2, 1]);
});

test("merge: a domain story, a tech task or a spike needs an accepting acceptance tester – a chore or a task does not", () => {
  const facts = {
    current: `marathon/${RUN}`, dirty: [], storyStatus: "done", branchExists: true, branchMerged: true,
    verify: { branch: `marathon/${RUN}`, ok: true, commit: "abc1234", dirty: false, failed: [] }, verifyCoversMerge: true, changedSinceVerify: [], repoMapStale: false,
  };
  for (const type of ["domain", "tech-task", "spike"]) {
    const state = claim(type);
    assert.match(mergeErrors(state, "ST-001", state.claims["ST-001"], facts).join("\n"), new RegExp(`a ${type} story is merged only after the acceptance-tester accepted it`));
    const reviewed = applyReview(state, "ST-001", { agent: "acceptance-tester", verdict: "accepted-with-remarks", blocker: 0, major: 0, minor: 1, question: 0 }, T1).state;
    assert.deepEqual(mergeErrors(reviewed, "ST-001", reviewed.claims["ST-001"], facts), [], type);
    const refused = applyReview(state, "ST-001", { agent: "acceptance-tester", verdict: "not-accepted", blocker: 1, major: 0, minor: 0, question: 0 }, T1).state;
    assert.equal(mergeErrors(refused, "ST-001", refused.claims["ST-001"], facts).length, 1, `${type}: not accepted`);
  }
  for (const type of ["chore", "task"]) {
    const state = claim(type);
    assert.deepEqual(mergeErrors(state, "ST-001", state.claims["ST-001"], facts), [], type);
  }
  const state = claim("chore");
  assert.match(mergeErrors(state, "ST-001", state.claims["ST-001"], { ...facts, repoMapStale: true })[0], /the repository map is stale after the merge – run .*repo-map\.ts/);
});

test("summary: passes after a cut-off are named, and decisions taken with a default wait for the user's nod", () => {
  let state = applyResume(claim("chore"), { "ST-001": { branchExists: true, merged: false } }, [], T1).state;
  const decision = { question: "Which time zone is 'today'?", decision: "the process's local time zone", why: "the conventions name days without a zone; one line in clock.ts" };
  state.results["ST-001"] = { outcome: "merged", at: T1, attempts: 2, resumed: 1, type: "chore", decisions: [decision] };
  delete state.claims["ST-001"];
  const text = renderSummary(state, new Map([["ST-001", "Foundation"]]), "–");
  assert.match(text, /\| ST-001 \| Foundation \| chore \| 2 \(1 after a cut-off\) \|/);
  assert.match(text, /## Decided with a default – confirm or change\n\n- \*\*ST-001\*\*: Which time zone is 'today'\? → \*\*the process's local time zone\*\* – the conventions name days/);
});

// --------------------------------------------------------------------------
// The hooks
// --------------------------------------------------------------------------
function stateDir(lease, run = { status: "running", run: RUN }) {
  const dir = mkdtempSync(join(tmpdir(), "kataster-lease-"));
  if (lease) writeFileSync(join(dir, "marathon-lease.json"), JSON.stringify(lease));
  if (run) writeFileSync(join(dir, "marathon.json"), JSON.stringify(run));
  return dir;
}

function guard(dir, payload) {
  const r = spawnSync(process.execPath, [join(hooks, "marathon-guard.ts")], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, KATASTER_STATE_DIR: dir },
  });
  return { code: r.status, err: r.stderr };
}

test("marathon-guard: a superseded session is blocked on every tool while the run runs; the holder and everyone else are not", () => {
  const { lease } = takeWorker(takeOrchestrator(takeOrchestrator(null, RUN, "opencode:a", T0), RUN, "opencode:b", T1), RUN, "ST-001", 2, "claude-code:w2", T1);
  const dir = stateDir(lease);
  const bash = { tool_name: "Bash", tool_input: { command: "git commit -m x" } };

  const blocked = guard(dir, { ...bash, session_id: "a", harness: "opencode" });
  assert.equal(blocked.code, 2);
  assert.match(blocked.err, /Blocked: marathon run 2026-11-26 replaced this orchestrator at .* Stop: end your turn/);
  assert.equal(guard(dir, { tool_name: "subagent", tool_input: {}, session_id: "a", harness: "opencode" }).code, 2, "it starts no worker either");
  assert.equal(guard(dir, { ...bash, session_id: "b", harness: "opencode" }).code, 0);
  assert.equal(guard(dir, { ...bash, session_id: "main", agent_id: "w2" }).code, 0, "the worker of the claim");
  assert.equal(guard(dir, { ...bash, session_id: "a" }).code, 0, "the same id in the other harness is another session");

  // A finished run, no lease, no run: nothing to guard.
  assert.equal(guard(stateDir(lease, { status: "finished", run: RUN }), { ...bash, session_id: "a", harness: "opencode" }).code, 0);
  assert.equal(guard(stateDir(null), { ...bash, session_id: "a", harness: "opencode" }).code, 0);
  assert.equal(guard(stateDir(lease, { status: "running", run: "2026-11-27" }), { ...bash, session_id: "a", harness: "opencode" }).code, 0);
});

test("marathon-guard: nobody schedules work for later while a run is running", () => {
  const dir = stateDir(takeOrchestrator(null, RUN, "claude-code:s1", T0));
  const cron = guard(dir, { tool_name: "CronCreate", tool_input: {}, session_id: "s1" });
  assert.equal(cron.code, 2);
  assert.match(cron.err, /work scheduled for later \(CronCreate\) would run outside the run/);
  assert.equal(guard(dir, { tool_name: "execute", tool_input: { code: "await tools.automation.create({})" }, session_id: "x", harness: "opencode" }).code, 2);
  assert.equal(guard(dir, { tool_name: "execute", tool_input: { code: "return 1" }, session_id: "x", harness: "opencode" }).code, 0);
  assert.equal(guard(stateDir(null, null), { tool_name: "CronCreate", tool_input: {}, session_id: "s1" }).code, 0, "outside a run it is the user's business");
});

function rewrite(command, payload = { session_id: "s1" }) {
  const r = spawnSync(process.execPath, [join(hooks, "metrics.ts")], {
    input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, ...payload }),
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput.updatedInput.command : null;
}

test("the hooks tell worker.ts and marathon-state.ts who calls – only where the script really runs", () => {
  assert.equal(
    rewrite("node .claude/skills/marathon/scripts/marathon-state.ts claim ST-001"),
    "node .claude/skills/marathon/scripts/marathon-state.ts claim --caller 'claude-code:s1' ST-001",
  );
  assert.equal(rewrite("node .claude/skills/marathon/scripts/marathon-state.ts resume"), "node .claude/skills/marathon/scripts/marathon-state.ts resume --caller 'claude-code:s1'");
  assert.equal(
    rewrite("node .claude/skills/implement/scripts/worker.ts start ST-001 --base marathon/2026-11-26", { session_id: "s1", agent_id: "a7" }),
    "node .claude/skills/implement/scripts/worker.ts start --caller 'claude-code:a7' ST-001 --base marathon/2026-11-26",
  );
  assert.equal(
    rewrite("node .claude/skills/implement/scripts/worker.ts report ST-001 --base b --result blocked --details .kataster/details/ST-001.json", { session_id: "ses_9", harness: "opencode" }),
    "node .claude/skills/implement/scripts/worker.ts report --caller 'opencode:ses_9' ST-001 --base b --result blocked --details .kataster/details/ST-001.json",
  );
  // Together with a metrics marker in one command.
  const both = rewrite("node .claude/skills/metrics/scripts/story-metrics.ts mark ST-001 integration start && node .claude/skills/marathon/scripts/marathon-state.ts status");
  assert.match(both, /story-metrics\.ts mark --harness claude-code --session 's1' ST-001 integration start/);
  assert.match(both, /marathon-state\.ts status --caller 'claude-code:s1'$/);
  // Text that only mentions the scripts is left alone, and so is a caller that is there already.
  assert.equal(rewrite("echo 'node .claude/skills/marathon/scripts/marathon-state.ts claim ST-001'"), null);
  assert.equal(rewrite("git commit -m 'run marathon-state.ts claim next'"), null);
  assert.equal(rewrite("node .claude/skills/marathon/scripts/marathon-state.ts claim --caller x ST-001"), null);
  assert.equal(rewrite("node .claude/skills/marathon/scripts/marathon-state.ts claim ST-001", {}), null, "no session, no caller");
});

test("both harnesses wire the marathon guard", async () => {
  const { readFileSync } = await import("node:fs");
  const settings = JSON.parse(readFileSync(resolve(here, "..", ".claude", "settings.json"), "utf8"));
  const entry = settings.hooks.PreToolUse.find((e) => e.hooks.some((h) => h.command.includes("marathon-guard.ts")));
  assert.ok(entry, "Claude Code runs marathon-guard.ts");
  for (const tool of ["Bash", "Write", "Edit", "Agent", "SendMessage", "CronCreate"]) assert.match(entry.matcher, new RegExp(`(^|\\|)${tool}(\\||$)`), tool);
  const plugin = readFileSync(resolve(here, "..", ".opencode", "plugins", "kataster", "index.ts"), "utf8");
  assert.match(plugin, /run\(\s*"marathon-guard\.ts"/);
  assert.match(plugin, /command\.includes\("worker\.ts"\) \|\| command\.includes\("marathon-state\.ts"\)/);
});

test("the rewrite never takes a command out of a deny or ask rule", () => {
  // A copy of the hooks in a project of its own: the rules are read from the project the hooks are installed in.
  const project = mkdtempSync(join(tmpdir(), "kataster-rewrite-"));
  const home = mkdtempSync(join(tmpdir(), "kataster-home-"));
  cpSync(resolve(hooks, "..", "lib"), join(project, ".claude", "lib"), { recursive: true });
  cpSync(hooks, join(project, ".claude", "hooks"), { recursive: true });
  mkdirSync(join(project, ".git"));
  const put = (root, path, value) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), typeof value === "string" ? value : JSON.stringify(value));
  };
  const status = "node .claude/skills/marathon/scripts/marathon-state.ts status";
  const call = (command, payload = {}) => {
    const r = spawnSync(process.execPath, [join(project, ".claude", "hooks", "metrics.ts")], {
      input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, session_id: "s1", ...payload }),
      encoding: "utf8",
      env: { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config") },
    });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput.updatedInput.command : null;
  };
  const rewritten = `${status} --caller 'claude-code:s1'`;
  assert.equal(call(status), rewritten);

  // Claude Code: exact deny and ask, in each settings file, also as one part of a compound command.
  for (const [root, file, effect] of [[project, ".claude/settings.json", "deny"], [project, ".claude/settings.local.json", "ask"], [home, ".claude/settings.json", "deny"]]) {
    put(root, file, { permissions: { [effect]: [`Bash(${status})`] } });
    assert.equal(call(status), null, `${file} ${effect}`);
    assert.equal(call(`git status && ${status}`), null, "compound");
    assert.equal(call("node .claude/skills/marathon/scripts/marathon-state.ts resume"), "node .claude/skills/marathon/scripts/marathon-state.ts resume --caller 'claude-code:s1'", "other commands are rewritten");
    rmSync(join(root, file));
  }
  // A rule that matches the rewritten command as well loses nothing: the lease keeps working.
  put(project, ".claude/settings.json", { permissions: { deny: [`Bash(${status} *)`, "Bash(git push *main*)"], ask: ["Bash(node *)"] } });
  assert.equal(call(status), rewritten);
  rmSync(join(project, ".claude/settings.json"));

  // OpenCode: its own configs, with comments; the list, the older key, agent rules and the global config.
  const oc = { harness: "opencode", session_id: "ses_1" };
  const exact = { action: "shell", resource: status, effect: "deny" };
  for (const [root, file, config] of [
    [project, ".opencode/opencode.jsonc", `// ours\n{ "permissions": [${JSON.stringify(exact)},] }`],
    [project, "opencode.json", { permission: { bash: { [status]: "ask" } } }],
    [project, "opencode.jsonc", { agents: { build: { permissions: [exact] } } }],
    [home, ".config/opencode/opencode.json", { permissions: [exact] }],
  ]) {
    put(root, file, config);
    assert.equal(call(status, oc), null, file);
    rmSync(join(root, file));
  }
  put(project, ".opencode/opencode.jsonc", { permissions: [{ action: "shell", resource: "*", effect: "deny" }, { action: "shell", resource: status, effect: "allow" }] });
  assert.equal(call(status, oc), `${status} --caller 'opencode:ses_1'`);
});

