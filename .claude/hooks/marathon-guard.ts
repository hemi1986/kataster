/**
 * PreToolUse hook (both harnesses): while a marathon run is running,
 *
 *   - a session the run superseded can do nothing any more – an orchestrator after another session resumed the run,
 *     a worker after a newer worker took its story (lib/lease.ts). Sessions can outlive their terminal (OpenCode runs
 *     them in its background service), and two workers on one checkout destroy each other's work.
 *   - nobody schedules work for later: Claude Code's cron/triggers/wakeups and OpenCode's automations would run
 *     outside the run, after the session that made them.
 *
 * Claude Code wires it for the writing and starting tools (settings.json); the OpenCode plugin runs it for every tool
 * that is not read-only. Fast path: without a lease file there is no run, and the hook exits at once.
 */
import { existsSync, readFileSync } from "node:fs";
import { callerOf, isScheduling, isSuperseded, LEASE_FILE, readLease, runningRun } from "../lib/lease.ts";

if (!existsSync(LEASE_FILE)) process.exit(0);

let data: Record<string, any>;
try {
  data = JSON.parse(readFileSync(0, "utf8"));
} catch {
  process.exit(0);
}

const lease = readLease();
const run = runningRun();
if (!lease || !run || lease.run !== run) process.exit(0);

function block(msg: string): never {
  process.stderr.write(`Blocked: ${msg}\n`);
  process.exit(2);
}

const gone = isSuperseded(lease, callerOf(data));
if (gone) {
  block(
    `marathon run ${run} replaced this ${gone.role}${gone.story ? ` of ${gone.story}` : ""} at ${gone.at} – another session runs it now. ` +
      "Stop: end your turn without further tool calls and without a report. (A person can still run commands with `! <command>`.)",
  );
}

const tool = String(data.tool_name ?? "");
if (isScheduling(tool, data.tool_input)) {
  block(`marathon run ${run} is running – work scheduled for later (${tool}) would run outside the run and after this session. Do it now, or leave it for the user.`);
}
process.exit(0);
