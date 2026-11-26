/**
 * Plans the next wave of a marathon run: the stories to start now.
 *
 * A story is planned when it is `ready`, all its `depends_on` are `done`, no worker holds a claim on it, the run did
 * not escalate it and it is not handed over already. The claim state is read from .claude/state/marathon.json
 * (`MARATHON_STATE_FILE` in lib/engineering.ts); without that file no run has started and nothing is claimed.
 * Read-only: the script never writes the state.
 *
 * Harness-neutral: Claude Code and OpenCode run the same command, the state path is resolved from this script's
 * location, not from the cwd.
 *
 * Usage: node .claude/skills/marathon/scripts/marathon-plan.ts [--n <workers>] [--json]
 */
import { parseArgs } from "../../../lib/args.ts";
import * as d from "../../../lib/discovery.ts";
import * as e from "../../../lib/engineering.ts";

const USAGE = `Usage: node .claude/skills/marathon/scripts/marathon-plan.ts [--n <workers>] [--json]

  --n <workers>  parallel workers (default 1; only 1 until conflict keys exist)
  --json         machine-readable plan`;

// Without conflict keys two stories of one wave may change the same aggregate; N > 1 waits for them.
const MAX_N = 1;

const args = parseArgs({ usage: USAGE, flags: ["--json"], values: ["--n"] });
const nRaw = args.values.get("--n") ?? "1";
const n = Number(nRaw);
if (!/^\d+$/.test(nRaw) || n < 1) {
  console.error(`--n needs a whole number ≥ 1, got '${nRaw}'.\n\n${USAGE}`);
  process.exit(2);
}
if (n > MAX_N) {
  console.error(`--n ${n}: more than ${MAX_N} worker needs conflict keys, which are not implemented yet.`);
  process.exit(2);
}

let state: e.MarathonState | null;
try {
  state = e.readMarathonState();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

const plan = e.planWave(e.storiesById(), state, n);
const brief = (s: d.Story) => ({ id: d.storyId(s), title: s.meta.title, type: s.meta.type, size: s.meta.size, path: d.rel(s.path) });

if (args.flags.has("--json")) {
  console.log(
    JSON.stringify(
      {
        stateFile: d.rel(e.MARATHON_STATE_FILE),
        run: state?.run ?? null,
        integrationBranch: state?.integrationBranch ?? null,
        n,
        slots: plan.slots,
        wave: plan.wave.map(({ story, attempts }) => ({ ...brief(story), attempts })),
        eligible: plan.eligible,
        claimed: plan.claimed,
        handedOver: plan.handedOver,
        escalated: plan.escalated,
        blocked: plan.blocked.map(({ story, waitingFor }) => ({ id: d.storyId(story), waitingFor })),
        reason: plan.reason,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

console.log(state ? `RUN          ${state.run} → ${state.integrationBranch}` : "RUN          none started (no .claude/state/marathon.json)");
for (const id of plan.claimed) {
  const c = state!.claims[id];
  console.log(`CLAIMED      ${id} on ${c.branch} since ${c.start} (attempt ${c.attempts})`);
}
for (const { story, attempts } of plan.wave) {
  const retry = attempts ? `, ${attempts} earlier attempt(s)` : "";
  console.log(`NEXT         ${d.storyId(story)} – ${story.meta.title} [${story.meta.type}, ${story.meta.size}${retry}] (${d.rel(story.path)})`);
}
if (plan.reason) console.log(`NEXT         none – ${plan.reason}`);
for (const { story, waitingFor } of plan.blocked) console.log(`BLOCKED      ${d.storyId(story)} – waits for ${waitingFor.join(", ")}`);
if (plan.handedOver.length) console.log(`HANDED OVER  ${plan.handedOver.join(", ")} – waiting for the user's merge`);
if (plan.escalated.length) console.log(`ESCALATED    ${plan.escalated.join(", ")} – skipped until the user decides`);
