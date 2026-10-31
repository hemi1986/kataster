/**
 * Builds the context pack for one story as Markdown: everything the implementation needs from discovery,
 * collected deterministically instead of by searching.
 *
 *   - the story itself and the exact test titles its scenarios need
 *   - dependencies and their status
 *   - from events.yaml: linked events, the commands producing them (with rules), their aggregates (with invariants),
 *     policies triggered by the events, every other ID the story mentions (read models, policies, hotspots, …)
 *     and the hotspots referring to any of these
 *   - glossary entries of every CONTEXT.md term the story uses
 *   - the data model sections of the aggregates involved
 *   - ADRs: those the story mentions in full, the others as a list
 *   - answered open questions about the story
 *
 * Usage: node story-context.ts ST-010 [> file]
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import * as d from "../../../lib/discovery.ts";
import * as e from "../../../lib/engineering.ts";

const id = process.argv[2]?.toUpperCase();
if (!id) {
  console.error("Usage: node story-context.ts ST-NNN");
  process.exit(1);
}
let story: d.Story;
try {
  story = e.findStory(id);
} catch (err) {
  console.error(String(err instanceof Error ? err.message : err));
  process.exit(1);
}
const stories = e.storiesById();
const list = (v: unknown): string[] => (Array.isArray(v) ? v : []);
const read = (p: string): string => (existsSync(p) ? readFileSync(p, "utf8") : "");
const storyText = read(story.path);
const out: string[] = [`# Context pack – ${id}: ${story.meta.title}`, ""];

// Story
out.push("## Story file", "", `\`${d.rel(story.path)}\``, "", "````markdown", storyText.trimEnd(), "````", "");
if (story.meta.type === "story") {
  out.push("## Test titles (exact)", "", "Every scenario gets one test with exactly this title:", "");
  for (const sc of e.scenarioTitles(story)) out.push(`- \`${e.testTitle(id, sc)}\``);
  out.push("");
} else {
  out.push("## Acceptance checklist", "", "Tick each item (`- [x]`) in the story file when it is done.", "");
}
const deps = list(story.meta.depends_on);
if (deps.length) {
  out.push("## Dependencies", "");
  for (const dep of deps) {
    const s = stories.get(dep);
    out.push(`- ${dep} – ${s?.meta.title ?? "(missing)"} – **${s?.meta.status ?? "?"}**`);
  }
  out.push("");
}

// Domain model
const model = d.loadEventsModel();
const aggregates = new Set<string>();
if (model) {
  const idx = d.indexModel(model);
  const items = (key: string): d.Obj[] => (model[key] ?? []) as d.Obj[];
  const picked = new Map<string, d.Obj>();
  const pick = (x: string) => {
    const item = idx.get(x);
    if (item) picked.set(x, item);
  };
  const events = list(story.meta.events);
  events.forEach(pick);
  for (const c of items("commands")) if (list(c.produces).some((ev) => events.includes(ev))) pick(c.id);
  for (const p of items("policies")) if (list(p.when).some((ev) => events.includes(ev))) pick(p.id);
  for (const m of storyText.matchAll(/\b(?:AGG|EVT|CMD|POL|RM|HS|ACT|EXT)-[A-Za-z0-9]+\b/g)) pick(m[0]);
  for (const item of picked.values()) if (item.aggregate) aggregates.add(item.aggregate);
  aggregates.forEach(pick);
  const ids = new Set(picked.keys());
  for (const h of items("hotspots")) if (list(h.refs).some((r) => ids.has(r))) pick(h.id);

  const order = ["EVT", "CMD", "AGG", "POL", "RM", "ACT", "EXT", "HS"];
  const sorted = [...picked.values()].sort(
    (a, b) => order.indexOf(a.id.split("-")[0]) - order.indexOf(b.id.split("-")[0]) || a.id.localeCompare(b.id),
  );
  out.push("## Event storming model (`docs/domain/events.yaml`)", "", "```yaml", stringify(sorted, { lineWidth: 0 }).trimEnd(), "```", "");
}

// Glossary
const glossary = read(join(d.ROOT, "CONTEXT.md"));
if (glossary) {
  const entries: string[] = [];
  const blocks = glossary.split(/\n(?=\*\*[^*]+\*\*:?\s*\n)/);
  const lowerStory = storyText.toLowerCase();
  for (const block of blocks.slice(1)) {
    const term = /^\*\*(.+?)\*\*/.exec(block)?.[1].replace(/:$/, "");
    if (!term) continue;
    const re = new RegExp(`\\b${term.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i");
    if (re.test(lowerStory)) entries.push(block.split(/\n(?=#)/)[0].trim());
  }
  if (entries.length) out.push("## Glossary (`CONTEXT.md`, terms used by the story)", "", ...entries.flatMap((x) => [x, ""]));
}

// Data model
const dataModel = read(join(d.ROOT, "docs", "architecture", "data-model.md"));
if (dataModel && aggregates.size) {
  const secs = dataModel.split(/\n(?=## )/);
  const hits = secs.filter((s) => [...aggregates].some((a) => s.split("\n")[0].includes(`\`${a}\``)));
  if (hits.length) out.push("## Data model (`docs/architecture/data-model.md`)", "", ...hits.flatMap((s) => [s.trim().replace(/^## /, "### "), ""]));
}

// ADRs
const adrDir = join(d.ROOT, "docs", "adr");
if (existsSync(adrDir)) {
  const adrs = readdirSync(adrDir).filter((f) => /^\d{4}-.*\.md$/.test(f)).sort();
  const mentioned = adrs.filter((f) => {
    const n = f.slice(0, 4);
    return storyText.includes(f) || new RegExp(`\\bADR[ -]?${n}\\b`).test(storyText);
  });
  out.push("## ADRs (`docs/adr/`)", "");
  for (const f of adrs) {
    const text = read(join(adrDir, f));
    const title = /^# (.+)$/m.exec(text)?.[1] ?? f;
    const status = /^status:\s*(.+)$/m.exec(text)?.[1] ?? "?";
    out.push(`- \`${f}\` – ${title} – ${status}${mentioned.includes(f) ? " – **mentioned by the story, full text below**" : ""}`);
  }
  out.push("");
  for (const f of mentioned) out.push(`### ${f}`, "", read(join(adrDir, f)).replace(/^---[\s\S]*?---\n/, "").trim().replace(/^# .*\n/, ""), "");
}

// Open questions
const oq = read(join(d.STORIES_DIR, "OPEN_QUESTIONS.md"));
const rows = oq.split("\n").filter((l) => l.startsWith("|") && new RegExp(`\\b${id}\\b`).test(l));
if (rows.length) out.push("## Open questions about this story", "", "| Story/artifact | Question | Since | Answer |", "|---|---|---|---|", ...rows, "");

console.log(out.join("\n"));
