/**
 * Story metrics: phase markers, collection and the report. See `.claude/skills/metrics/SKILL.md`.
 *
 *   mark <ST-NNN|feature:<slug>> <phase> start|end
 *       Records a phase marker. On `end` the pass's tokens and times are appended to
 *       docs/stories/metrics/<target>.json. The PreToolUse hook (Claude Code) / the plugin (OpenCode) adds
 *       --harness, --session, --agent, --agent-type and --transcript; without them the marker carries time only.
 *   collect [--session <id>] [--stale] [--idle-minutes <n>] [--since <ISO time>]
 *       Finalises runs: missing pass entries, passes left open, and the `unassigned` pot. The session hooks run it.
 *       `--since` takes every run with a marker since then, idle or not – the end of a marathon run.
 *   review <ST-NNN> <agent> --verdict <verdict> [--blocker n] [--major n] [--minor n] [--question n]
 *       Records one review of a story – who reviewed, the verdict, the findings per severity – in the story's
 *       metrics file. Whoever started the reviewer records it (a marathon run does it through marathon-state.ts).
 *   report [--story ST-NNN] [--feature <slug>] [--since YYYY-MM-DD] [--json]
 *       Tables per story, feature and size; cost from metrics.prices in .claude/project.json.
 */
import type { Harness, Marker } from "../../../lib/metrics.ts";
import type { ReviewVerdict } from "../../../lib/metrics.ts";
import { appendMarker, appendReview, collectPass, collectRuns, HARNESSES, isPhase, isStoryTarget, normalizeTarget, PHASES, REVIEW_VERDICTS, SEVERITIES, stateDir } from "../../../lib/metrics.ts";
import { collector } from "../../../lib/metrics-adapters.ts";
import { ROOT } from "../../../lib/config.ts";

const USAGE = `Usage:
  node .claude/skills/metrics/scripts/story-metrics.ts mark <ST-NNN|feature:<slug>> <phase> start|end
  node .claude/skills/metrics/scripts/story-metrics.ts collect [--session <id>] [--stale] [--idle-minutes <n>] [--since <ISO time>]
  node .claude/skills/metrics/scripts/story-metrics.ts review <ST-NNN> <agent> --verdict <verdict> [--blocker <n>] [--major <n>] [--minor <n>] [--question <n>]
  node .claude/skills/metrics/scripts/story-metrics.ts report [--story ST-NNN] [--feature <slug>] [--since YYYY-MM-DD] [--json]

Phases: ${PHASES.join(", ")}, review-<agent>
Verdicts: ${REVIEW_VERDICTS.join(", ")}
The hooks add --harness, --session, --agent, --agent-type and --transcript to 'mark' – do not pass them by hand.`;

function fail(message: string): never {
  console.error(`${message}\n\n${USAGE}`);
  process.exit(2);
}

/** Strict parsing: positionals in order, known options only, `--help` prints the usage. */
function parse(argv: string[], values: string[], flags: string[]): { pos: string[]; opts: Map<string, string>; flags: Set<string> } {
  const pos: string[] = [];
  const opts = new Map<string, string>();
  const set = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      process.exit(0);
    }
    if (!arg.startsWith("--")) {
      pos.push(arg);
      continue;
    }
    const [name, inline] = arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];
    if (flags.includes(name) && inline === undefined) set.add(name);
    else if (values.includes(name)) {
      const value = inline ?? argv[++i];
      if (value === undefined || value === "") fail(`${name} needs a value.`);
      opts.set(name, value);
    } else fail(`Unknown argument: ${arg}`);
  }
  return { pos, opts, flags: set };
}

const [command, ...rest] = process.argv.slice(2);

if (command === "mark") {
  const { pos, opts } = parse(rest, ["--harness", "--session", "--agent", "--agent-type", "--transcript"], []);
  if (pos.length !== 3) fail("mark needs <target> <phase> start|end.");
  const [rawTarget, phase, edge] = pos;
  const target = normalizeTarget(rawTarget);
  if (!target) fail(`'${rawTarget}' is not a target – use ST-NNN or feature:<kebab-slug>.`);
  if (!isPhase(phase)) fail(`'${phase}' is not a phase.`);
  if (edge !== "start" && edge !== "end") fail(`'${edge}' must be start or end.`);
  const harness = (opts.get("--harness") ?? (opts.has("--session") ? "claude-code" : "unknown")) as Harness;
  if (!HARNESSES.includes(harness)) fail(`--harness must be one of ${HARNESSES.join(", ")}.`);

  const marker: Marker = {
    // KATASTER_METRICS_NOW pins the clock – for tests against fixture transcripts only.
    ts: process.env.KATASTER_METRICS_NOW ?? new Date().toISOString(),
    target,
    phase,
    edge,
    harness,
    session: opts.get("--session") ?? "manual",
    agent: opts.get("--agent") ?? "main",
    agentType: opts.get("--agent-type") ?? (opts.has("--agent") ? "subagent" : "main"),
    root: ROOT,
  };
  if (opts.has("--transcript")) marker.transcript = opts.get("--transcript");
  const dir = stateDir();
  appendMarker(marker, dir);
  if (edge === "start") {
    console.log(`${target} ${phase}: started`);
    process.exit(0);
  }

  try {
    const result = collectPass(marker, await collector(dir));
    const written = result.written.reduce((n, w) => n + w.entries, 0);
    if (!written) console.log(`${target} ${phase}: ended – no open start found on this session, nothing written`);
    else console.log(`${target} ${phase}: ended – ${written} ${written === 1 ? "entry" : "entries"} appended to docs/stories/metrics/`);
    for (const w of result.warnings.filter((x) => !x.includes("without a start"))) console.error(`  ⚠ ${w}`);
  } catch (e) {
    // a metrics failure never blocks the workflow: the marker is recorded, `collect` can write the entries later
    console.error(`${target} ${phase}: ended – entries not written yet (${e instanceof Error ? e.message : String(e)}); the next session start collects them`);
  }
  process.exit(0);
}

if (command === "collect") {
  const { pos, opts, flags } = parse(rest, ["--session", "--idle-minutes", "--since"], ["--stale"]);
  if (pos.length) fail(`Unexpected argument: ${pos[0]}`);
  const idle = opts.has("--idle-minutes") ? Number(opts.get("--idle-minutes")) : 30;
  if (!Number.isFinite(idle) || idle < 0) fail("--idle-minutes must be a number ≥ 0.");
  const since = opts.has("--since") ? Date.parse(opts.get("--since")!) : undefined;
  if (since !== undefined && !Number.isFinite(since)) fail("--since needs an ISO time, e.g. 2026-11-26T17:09:51Z.");
  const result = collectRuns(await collector(), {
    runs: opts.has("--session") ? [opts.get("--session")!] : undefined,
    stale: since === undefined && (flags.has("--stale") || !opts.has("--session")),
    idleMs: idle * 60_000,
    since,
  });
  for (const w of result.written) console.log(`${w.target} ${w.phase}: ${w.entries} ${w.entries === 1 ? "entry" : "entries"}`);
  if (!result.written.length) console.log("Nothing to collect.");
  for (const w of result.warnings) console.error(`⚠ ${w}`);
  process.exit(0);
}

if (command === "review") {
  const { pos, opts } = parse(rest, ["--verdict", ...SEVERITIES.map((x) => `--${x}`)], []);
  if (pos.length !== 2) fail("review needs <ST-NNN> <agent>.");
  const target = normalizeTarget(pos[0]);
  if (!target || !isStoryTarget(target)) fail(`'${pos[0]}' is not a story id.`);
  const agent = pos[1];
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(agent)) fail(`'${agent}' is not an agent name.`);
  const verdict = opts.get("--verdict") as ReviewVerdict | undefined;
  if (!verdict || !REVIEW_VERDICTS.includes(verdict)) fail(`--verdict must be one of ${REVIEW_VERDICTS.join(", ")}.`);
  const counts = { blocker: 0, major: 0, minor: 0, question: 0 };
  for (const severity of SEVERITIES) {
    const raw = opts.get(`--${severity}`);
    if (raw === undefined) continue;
    if (!/^\d+$/.test(raw)) fail(`--${severity} needs a whole number ≥ 0, got '${raw}'.`);
    counts[severity] = Number(raw);
  }
  const at = process.env.KATASTER_METRICS_NOW ?? new Date().toISOString();
  const written = appendReview(ROOT, target, { agent, verdict, ...counts, at });
  console.log(`${target} review by ${agent}: ${verdict.replaceAll("-", " ")} – ${written ? "recorded in docs/stories/metrics/" : "already recorded"}`);
  process.exit(0);
}

if (command === "report") {
  const { pos, opts, flags } = parse(rest, ["--story", "--feature", "--since"], ["--json"]);
  if (pos.length) fail(`Unexpected argument: ${pos[0]}`);
  const story = opts.get("--story")?.toUpperCase();
  if (story && !/^ST-\d{3,}$/.test(story)) fail(`--story '${story}' is not a story id.`);
  const feature = opts.get("--feature")?.replace(/^feature:/, "");
  // The report reads the story files – it needs the tooling dependencies, the hooks and `mark` do not.
  const { buildReport, renderReport } = await import("../../../lib/metrics-report.ts");
  try {
    const data = buildReport({ story, feature, since: opts.get("--since") });
    console.log(flags.has("--json") ? JSON.stringify(data, null, 2) : renderReport(data, { story, feature }));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
  process.exit(0);
}

fail(command ? `Unknown command: ${command}` : "No command given.");
