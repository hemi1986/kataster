/**
 * Mechanical health check of the open backlog – step 1 of `/groom-backlog`.
 *
 * Finds what nobody spots by reading 60 story files, and what `validate-stories.ts` deliberately does not check
 * (that one answers "is this file well-formed?", this one answers "does this backlog still make sense?"):
 *
 *   FINDING  dependency cycle – the stories involved can never start
 *   FINDING  a story depends on one that is dropped (`wont`) or does not exist
 *   FINDING  priority inversion – a `must` waits for a story of lower priority
 *   FINDING  a ready story is blocked by a story that is still draft/review
 *   FINDING  a dead domain reference – an event or an ID in the body that events.yaml no longer has
 *   FINDING  a story that is not done but already has tests for its scenarios (left in progress, or built elsewhere)
 *   FINDING  an [OPEN] marker, or an open row in OPEN_QUESTIONS.md older than the threshold
 *   FINDING  a story with a screen that has not decided its empty case, its rejection or its permission (G7/G8/G11)
 *   INFO     depth of the dependency chain per story, and what is reachable at all
 *
 * Findings are material for the grooming conversation, not errors: this script never fails a build.
 * Exit code is always 0 unless the stories cannot be read at all.
 *
 * Usage: node backlog-health.ts [BC-Name | ST-NNN ...]   (empty = every story that is not done)
 */
import * as d from "../../../lib/discovery.ts";
import * as e from "../../../lib/engineering.ts";

const STALE_DAYS = 30;

const args = process.argv.slice(2).map((a) => a.toUpperCase());
const wantedIds = new Set(args.filter((a) => /^ST-\d+$/.test(a)));
const wantedContexts = new Set(args.filter((a) => a.startsWith("BC-")));

const { parsed, failures } = d.loadStories();
if (!parsed.length) {
  console.error("No stories in docs/stories/ – nothing to groom.");
  process.exit(1);
}
for (const [path, why] of failures) console.log(`FINDING  ${d.rel(path)}: unreadable frontmatter – ${why}`);

const byId = new Map(parsed.map((s) => [d.storyId(s), s]));
const meta = (s: d.Story, key: string): unknown => s.meta[key];
const str = (s: d.Story, key: string): string => (typeof meta(s, key) === "string" ? String(meta(s, key)) : "");
const arr = (s: d.Story, key: string): string[] => (Array.isArray(meta(s, key)) ? (meta(s, key) as string[]) : []);
const open = parsed.filter((s) => str(s, "status") !== "done");

function selected(s: d.Story): boolean {
  if (!wantedIds.size && !wantedContexts.size) return true;
  return wantedIds.has(d.storyId(s)) || wantedContexts.has(str(s, "context").toUpperCase());
}

const scope = open.filter(selected);
if (!scope.length) {
  console.log(`No open stories match ${args.join(", ")}.`);
  process.exit(0);
}

const findings: string[] = [];
const info: string[] = [];
const find = (id: string, msg: string): void => void findings.push(`${id}: ${msg}`);

// --------------------------------------------------------------------------
// Dependencies
// --------------------------------------------------------------------------
const PRIORITY_RANK: Record<string, number> = { must: 0, should: 1, could: 2, wont: 3 };
const rank = (s: d.Story): number => PRIORITY_RANK[str(s, "priority")] ?? 9;

/** The cycle through `id`, as a list of IDs, or null. Depth-first over depends_on. */
function cycleThrough(id: string): string[] | null {
  const seen = new Map<string, number>();
  const stack: string[] = [];
  const walk = (current: string): string[] | null => {
    const at = seen.get(current);
    if (at !== undefined) return at >= 0 ? [...stack.slice(at), current] : null;
    seen.set(current, stack.length);
    stack.push(current);
    for (const next of arr(byId.get(current) ?? ({ meta: {} } as d.Story), "depends_on")) {
      const found = walk(next);
      if (found) return found;
    }
    stack.pop();
    seen.set(current, -1);
    return null;
  };
  return walk(id);
}

const reported = new Set<string>();
for (const s of scope) {
  const id = d.storyId(s);
  const cycle = cycleThrough(id);
  if (cycle && !cycle.some((c) => reported.has(c))) {
    cycle.forEach((c) => reported.add(c));
    find(id, `dependency cycle – ${cycle.join(" → ")}. None of these can ever start.`);
  }
}

for (const s of scope) {
  const id = d.storyId(s);
  for (const dep of arr(s, "depends_on")) {
    const target = byId.get(dep);
    if (!target) {
      find(id, `depends on ${dep}, which does not exist`);
      continue;
    }
    const depStatus = str(target, "status");
    if (str(target, "priority") === "wont") {
      find(id, `depends on ${dep}, which is dropped (priority wont) – ${id} can never start`);
    }
    if (depStatus === "done") continue;
    if (rank(target) > rank(s)) {
      find(
        id,
        `priority inversion – ${str(s, "priority")} story waits for ${dep} (${str(target, "priority")}): ` +
          `either ${dep} is more important than its priority says, or ${id} is less.`,
      );
    }
    if (str(s, "status") === "ready" && ["draft", "review"].includes(depStatus)) {
      find(id, `is ready but waits for ${dep}, which is still ${depStatus} – it cannot be implemented yet`);
    }
  }
}

/** How many stories have to be done before this one can start (dependencies that are not done). */
function chainDepth(id: string, seen = new Set<string>()): number {
  if (seen.has(id)) return 0;
  seen.add(id);
  const s = byId.get(id);
  if (!s || str(s, "status") === "done") return 0;
  const deps = arr(s, "depends_on").filter((dep) => str(byId.get(dep) ?? ({ meta: {} } as d.Story), "status") !== "done");
  return deps.length ? 1 + Math.max(...deps.map((dep) => chainDepth(dep, seen))) : 0;
}

const deepest = scope
  .map((s) => ({ id: d.storyId(s), title: str(s, "title"), depth: chainDepth(d.storyId(s)) }))
  .sort((a, b) => b.depth - a.depth)
  .slice(0, 5)
  .filter((x) => x.depth > 1);
for (const x of deepest) info.push(`${x.id} sits ${x.depth} stories deep in the dependency chain – "${x.title}"`);

// --------------------------------------------------------------------------
// Domain references that no longer exist
// --------------------------------------------------------------------------
const model = d.loadEventsModel();
if (model) {
  const known = d.indexModel(model);
  const idRe = /\b(?:ACT|EXT|BC|AGG|EVT|CMD|POL|RM|HS|FLOW)-[A-Z][A-Za-z0-9]+\b/g;
  for (const s of scope) {
    const id = d.storyId(s);
    const dead = new Set<string>();
    for (const ev of arr(s, "events")) if (!known.has(ev)) dead.add(`${ev} (frontmatter)`);
    for (const m of s.body.matchAll(idRe)) if (!known.has(m[0])) dead.add(m[0]);
    if (dead.size) find(id, `refers to IDs that events.yaml no longer has: ${[...dead].join(", ")}`);
  }
}

// --------------------------------------------------------------------------
// Already built, although the story is not done
// --------------------------------------------------------------------------
const titles = e.testTitles();
for (const s of scope) {
  if (str(s, "type") !== "story") continue;
  const id = d.storyId(s);
  const { covered, missing } = e.scenarioCoverage(s, titles);
  if (covered.length && missing.length) {
    find(id, `${covered.length} of ${covered.length + missing.length} scenarios already have a test – partly built`);
  } else if (covered.length && !missing.length) {
    find(id, `every scenario already has a test, although the story is ${str(s, "status")} – is it done?`);
  }
}

// --------------------------------------------------------------------------
// Stories with a screen that have not decided their states (UX guidelines G7, G8, G11)
// --------------------------------------------------------------------------
// `validate-stories.ts` warns about these while a story is draft or review. Here every open story is checked,
// including the `ready` ones approved under the older rules – that debt belongs in a grooming conversation, not
// in the output of every single write. Grouped per guideline, because forty separate lines drown everything else.
const perGuideline = new Map<string, string[]>();
for (const s of scope) {
  for (const w of d.completenessWarnings(s)) {
    const guideline = /UX guideline (G\d+[a-z]?)/.exec(w)?.[1] ?? "G?";
    perGuideline.set(guideline, [...(perGuideline.get(guideline) ?? []), d.storyId(s)]);
  }
}
const GUIDELINE_GAP: Record<string, string> = {
  G7: "no scenario for the empty case",
  G8: "a rejection that never says what happens to what was typed",
  G11: "a permission rejection without the \"is not offered\" half",
};
for (const [guideline, ids] of [...perGuideline].sort()) {
  findings.push(
    `worth a look – ${ids.length} stories with a screen may have ${GUIDELINE_GAP[guideline] ?? guideline} ` +
      `(${guideline}); the wording check cannot tell whether the guideline applies, the ux-designer can: ${ids.join(", ")}`,
  );
}

// --------------------------------------------------------------------------
// Decisions that were parked
// --------------------------------------------------------------------------
for (const s of scope) {
  const marks = (s.body.match(/\[OPEN\]/g) ?? []).length;
  if (marks) find(d.storyId(s), `${marks} [OPEN] marker(s) – a decision is still missing`);
}

const questions = d.rel(`${d.STORIES_DIR}/OPEN_QUESTIONS.md`);
const openRows: string[] = [];
try {
  const text = (await import("node:fs")).readFileSync(`${d.STORIES_DIR}/OPEN_QUESTIONS.md`, "utf8");
  const today = Date.now();
  for (const line of text.split("\n")) {
    const cells = line.split("|").map((c) => c.trim());
    if (cells.length < 6 || !/^\d{4}-\d{2}-\d{2}$/.test(cells[3] ?? "")) continue;
    if (cells[4]) continue; // already answered
    const days = Math.round((today - Date.parse(cells[3])) / 86_400_000);
    if (days >= STALE_DAYS) openRows.push(`${cells[1]} – unanswered for ${days} days: ${cells[2].slice(0, 90)}…`);
  }
} catch {
  /* no open questions file */
}
for (const row of openRows) findings.push(`${questions}: ${row}`);

// --------------------------------------------------------------------------
// Report
// --------------------------------------------------------------------------
const counts = new Map<string, number>();
for (const s of scope) {
  const key = `${str(s, "status")}/${str(s, "priority")}`;
  counts.set(key, (counts.get(key) ?? 0) + 1);
}
console.log(
  `INFO     ${scope.length} open stories in scope` +
    (args.length ? ` (${args.join(", ")})` : "") +
    ` – ${[...counts].sort().map(([k, n]) => `${k}: ${n}`).join(", ")}`,
);
for (const line of info) console.log(`INFO     ${line}`);
for (const line of findings) console.log(`FINDING  ${line}`);
console.log(
  findings.length
    ? `\n${findings.length} finding(s) – material for the grooming conversation, not errors.`
    : "\nBacklog health OK – nothing mechanical to challenge.",
);
