/**
 * Shared, deterministic logic for the discovery artifacts.
 *
 * Used by hooks and skill scripts:
 *   - validation of docs/domain/events.yaml (schema + referential integrity)
 *   - rendering of docs/domain/event-storming.md (Mermaid)
 *   - validation of the stories in docs/stories/*.md
 *   - rendering of docs/stories/BACKLOG.md
 *
 * Only runtime dependency: `yaml`. Runs directly on Node >= 22.18 (type stripping),
 * so only erasable TypeScript syntax is allowed (no enums, namespaces, parameter properties).
 * The JSON schemas live in the skills as standard JSON Schema (for editor support)
 * and are checked here with a small built-in validator.
 */
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { parse as parseYaml, YAMLError } from "yaml";
import { isManagedLabel, labelPrefix, loadBacklogConfig } from "./config.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Obj = Record<string, any>;

export const ROOT = resolve(import.meta.dirname, "..", "..");
const SKILLS = join(ROOT, ".claude", "skills");
export const EVENTS_FILE = join(ROOT, "docs", "domain", "events.yaml");
const EVENTS_SCHEMA = join(SKILLS, "event-storming", "schema", "events.schema.json");
const EVENT_STORMING_MD = join(ROOT, "docs", "domain", "event-storming.md");
export const STORIES_DIR = join(ROOT, "docs", "stories");
const STORY_SCHEMA = join(SKILLS, "user-stories", "schema", "story.schema.json");
const BACKLOG_MD = join(STORIES_DIR, "BACKLOG.md");
const NON_STORY_FILES = new Set(["OPEN_QUESTIONS.md", "README.md", "BACKLOG.md"]);

export const LIST_KEYS = [
  "actors", "external_systems", "bounded_contexts", "aggregates", "events",
  "commands", "policies", "read_models", "hotspots", "flows",
] as const;
const KIND_LABEL: Record<string, string> = {
  ACT: "actor", EXT: "external system", BC: "bounded context",
  AGG: "aggregate", EVT: "event", CMD: "command", POL: "policy",
  RM: "read model", HS: "hotspot", FLOW: "flow", ST: "story",
};

/**
 * `superseded`: never built as written – its work was done elsewhere (a direct change, another story) or a new planning
 * replaces it. The file stays as the record other documents link to; it is final and counts toward no progress (user,
 * 2026-10-25).
 */
export const STATUSES = ["draft", "review", "ready", "in-progress", "done", "superseded"] as const;
/** Statuses that require a finished story: size set, no [OPEN] markers. */
export const COMMITTED = new Set(["ready", "in-progress", "done"]);
export const MAX_SCENARIOS = 10;
const PRIORITIES = ["must", "should", "could", "wont"];

// --------------------------------------------------------------------------
// Report
// --------------------------------------------------------------------------
export class Report {
  errors: string[] = [];
  warnings: string[] = [];

  error(where: string, msg: string): void {
    this.errors.push(`${where}: ${msg}`);
  }

  warn(where: string, msg: string): void {
    this.warnings.push(`${where}: ${msg}`);
  }

  get ok(): boolean {
    return this.errors.length === 0;
  }

  lines(): string[] {
    return [...this.errors.map((e) => `ERROR    ${e}`), ...this.warnings.map((w) => `WARNING  ${w}`)];
  }
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------
const list = (v: unknown): string[] => (Array.isArray(v) ? v : []);
const items = (model: Obj, key: string): Obj[] => list(model[key]) as unknown as Obj[];
const prefix = (id: string): string => id.split("-", 1)[0];

/** Resolves symlinks where possible so paths from hooks and from ROOT compare equal. */
export function realPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/** Project-relative POSIX path, or the input unchanged if it lies outside the project. */
export function rel(p: string): string {
  const r = relative(realPath(ROOT), realPath(p));
  return r.startsWith("..") || resolve(r) === r ? p : r.split(sep).join("/");
}

// --------------------------------------------------------------------------
// Mini JSON Schema validator (the subset our schemas use)
// --------------------------------------------------------------------------
function isType(v: unknown, t: string): boolean {
  switch (t) {
    case "string": return typeof v === "string";
    case "integer": return Number.isInteger(v);
    case "number": return typeof v === "number" && Number.isFinite(v);
    case "boolean": return typeof v === "boolean";
    case "array": return Array.isArray(v);
    case "object": return v !== null && typeof v === "object" && !Array.isArray(v);
    case "null": return v === null;
    default: return false;
  }
}

const fmt = (v: unknown): string =>
  v === null || v === undefined ? "null" : typeof v === "object" ? JSON.stringify(v) : String(v);

function check(inst: unknown, sch: Obj, root: Obj, path: (string | number)[], errs: string[]): void {
  if ("$ref" in sch) {
    let node: Obj = root;
    for (const part of String(sch.$ref).replace(/^#\//, "").split("/")) node = node[part];
    check(inst, node, root, path, errs);
    const { $ref: _ref, ...siblings } = sch; // sibling keywords (2020-12)
    sch = siblings;
  }
  const loc = path.join("/") || "(root)";
  if ("const" in sch && inst !== sch.const) {
    errs.push(`${loc}: must be ${JSON.stringify(sch.const)}`);
  }
  if ("enum" in sch && !sch.enum.includes(inst)) {
    errs.push(`${loc}: '${fmt(inst)}' not allowed (allowed: ${sch.enum.map(fmt).join(", ")})`);
  }
  if ("type" in sch) {
    const types: string[] = Array.isArray(sch.type) ? sch.type : [sch.type];
    if (!types.some((t) => isType(inst, t))) {
      errs.push(`${loc}: expected ${types.join("/")}, found '${fmt(inst)}'`);
      return;
    }
  }
  if (typeof inst === "string") {
    const len = [...inst].length;
    if (len < (sch.minLength ?? 0)) errs.push(`${loc}: too short (min. ${sch.minLength} characters)`);
    if (sch.maxLength !== undefined && len > sch.maxLength) errs.push(`${loc}: too long (max. ${sch.maxLength} characters)`);
    if (sch.pattern !== undefined && !new RegExp(sch.pattern, "u").test(inst)) {
      errs.push(`${loc}: '${inst}' does not match ${sch.pattern}`);
    }
  }
  if (typeof inst === "number" && sch.minimum !== undefined && inst < sch.minimum) {
    errs.push(`${loc}: must be >= ${sch.minimum}`);
  }
  if (Array.isArray(inst)) {
    if (inst.length < (sch.minItems ?? 0)) errs.push(`${loc}: at least ${sch.minItems} entries required`);
    if (sch.uniqueItems) {
      const seen = inst.map((i) => JSON.stringify(i));
      if (new Set(seen).size !== seen.length) errs.push(`${loc}: entries must be unique`);
    }
    if (sch.items) inst.forEach((item, i) => check(item, sch.items, root, [...path, i], errs));
  }
  if (isType(inst, "object")) {
    const obj = inst as Obj;
    for (const req of list(sch.required)) {
      if (!(req in obj)) errs.push(`${loc}: required field '${req}' is missing`);
    }
    const props: Obj = sch.properties ?? {};
    if (sch.additionalProperties === false) {
      for (const k of Object.keys(obj)) {
        if (!(k in props)) errs.push(`${loc}: unknown field '${k}' (allowed: ${Object.keys(props).join(", ")})`);
      }
    }
    for (const [k, v] of Object.entries(obj)) {
      if (k in props) check(v, props[k], root, [...path, k], errs);
    }
  }
}

function schemaErrors(instance: unknown, schemaPath: string): string[] {
  const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
  const errs: string[] = [];
  check(instance, schema, schema, [], errs);
  return errs;
}

// --------------------------------------------------------------------------
// Event storming model
// --------------------------------------------------------------------------
/** Loads events.yaml without validation (null if missing or invalid). */
export function loadEventsModel(): Obj | null {
  if (!existsSync(EVENTS_FILE)) return null;
  try {
    const data = parseYaml(readFileSync(EVENTS_FILE, "utf8"));
    return isType(data, "object") ? data : null;
  } catch (e) {
    if (e instanceof YAMLError) return null;
    throw e;
  }
}

export type Index = Map<string, Obj>;

export function indexModel(model: Obj): Index {
  const idx: Index = new Map();
  for (const key of LIST_KEYS) {
    for (const item of items(model, key)) {
      if (isType(item, "object") && typeof item.id === "string" && !idx.has(item.id)) idx.set(item.id, item);
    }
  }
  return idx;
}

export function validateEvents(report: Report): Obj | null {
  const where = rel(EVENTS_FILE);
  if (!existsSync(EVENTS_FILE)) {
    report.error(where, "file is missing");
    return null;
  }
  let model: unknown;
  try {
    model = parseYaml(readFileSync(EVENTS_FILE, "utf8"));
  } catch (e) {
    if (!(e instanceof YAMLError)) throw e;
    report.error(where, `invalid YAML: ${e.message}`);
    return null;
  }
  if (!isType(model, "object")) {
    report.error(where, "root must be an object");
    return null;
  }
  const m = model as Obj;

  for (const e of schemaErrors(m, EVENTS_SCHEMA)) report.error(where, e);
  if (!report.ok) return m; // check references only once the schema is valid

  // IDs are unique across the whole model
  const idx: Index = new Map();
  for (const key of LIST_KEYS) {
    for (const item of items(m, key)) {
      if (idx.has(item.id)) report.error(where, `ID '${item.id}' is used more than once`);
      idx.set(item.id, item);
    }
  }

  const ref = (owner: string, field: string, value: unknown, allowed: string[]): void => {
    if (value === undefined || value === null) return;
    for (const v of Array.isArray(value) ? value : [value]) {
      if (!idx.has(v)) {
        report.error(where, `${owner}.${field}: '${v}' does not exist`);
      } else if (!allowed.includes(prefix(v))) {
        report.error(where, `${owner}.${field}: '${v}' is not a ${allowed.map((a) => KIND_LABEL[a]).join(" or ")}`);
      }
    }
  };
  const allButFlow = Object.keys(KIND_LABEL).filter((p) => p !== "FLOW" && p !== "ST");

  for (const a of items(m, "aggregates")) ref(a.id, "context", a.context, ["BC"]);
  for (const e of items(m, "events")) {
    ref(e.id, "aggregate", e.aggregate, ["AGG"]);
    ref(e.id, "context", e.context, ["BC"]);
    const agg = idx.get(e.aggregate ?? "") ?? {};
    if (e.context && agg.context && agg.context !== e.context) {
      report.error(where, `${e.id}: context '${e.context}' contradicts the aggregate's context '${agg.context}'`);
    }
  }
  for (const c of items(m, "commands")) {
    ref(c.id, "actor", c.actor, ["ACT", "EXT"]);
    ref(c.id, "aggregate", c.aggregate, ["AGG"]);
    ref(c.id, "produces", c.produces, ["EVT"]);
  }
  for (const p of items(m, "policies")) {
    ref(p.id, "when", p.when, ["EVT"]);
    ref(p.id, "then", p.then, ["CMD"]);
  }
  for (const r of items(m, "read_models")) {
    ref(r.id, "fed_by", r.fed_by, ["EVT"]);
    ref(r.id, "used_by", r.used_by, ["ACT", "EXT"]);
  }
  for (const h of items(m, "hotspots")) ref(h.id, "refs", h.refs, allButFlow);
  for (const f of items(m, "flows")) ref(f.id, "sequence", f.sequence, allButFlow);

  // Heuristic warnings (non-blocking)
  const produced = new Set(items(m, "commands").flatMap((c) => list(c.produces)));
  const policyCmds = new Set(items(m, "policies").flatMap((p) => list(p.then)));
  for (const e of items(m, "events")) {
    if ((e.origin ?? "command") === "command" && !produced.has(e.id)) {
      report.warn(where, `${e.id}: not produced by any command (missing command? otherwise set origin: external|time)`);
    }
    if (!e.aggregate) report.warn(where, `${e.id}: not assigned to an aggregate yet`);
    if (!e.context && !e.aggregate) report.warn(where, `${e.id}: not assigned to a bounded context yet`);
  }
  for (const c of items(m, "commands")) {
    if (!c.actor && !policyCmds.has(c.id)) report.warn(where, `${c.id}: neither an actor nor a triggering policy`);
  }
  const openHs = items(m, "hotspots").filter((h) => (h.status ?? "open") === "open").map((h) => h.id);
  if (openHs.length) report.warn(where, `${openHs.length} open hotspots: ${openHs.join(", ")}`);
  return m;
}

// --------------------------------------------------------------------------
// Mermaid rendering
// --------------------------------------------------------------------------
const CLASSDEFS = `    classDef evt fill:#a3391f,stroke:#e65100,color:#fff
    classDef cmd fill:#64b5f6,stroke:#0d47a1,color:#000
    classDef pol fill:#ce93d8,stroke:#4a148c,color:#000
    classDef rm fill:#81c784,stroke:#1b5e20,color:#000
    classDef act fill:#a3751f,stroke:#f57f17,color:#000
    classDef ext fill:#f48fb1,stroke:#880e4f,color:#000
    classDef agg fill:#ffe082,stroke:#ff6f00,color:#000
    classDef hs fill:#e57373,stroke:#b71c1c,color:#fff`;

const SHAPES: Record<string, [string, string, string]> = {
  EVT: ['["', '"]', "evt"], CMD: ['["', '"]', "cmd"], POL: ['{{"', '"}}', "pol"],
  RM: ['[("', '")]', "rm"], ACT: ['(["', '"])', "act"], EXT: ['[["', '"]]', "ext"],
  AGG: ['[/"', '"/]', "agg"], HS: ['>"', '"]', "hs"], BC: ['["', '"]', "agg"],
};

const mid = (id: string): string => id.replace(/[^A-Za-z0-9_]/g, "_");

function node(id: string, item: Obj): string {
  const [left, right, cls] = SHAPES[prefix(id)] ?? ['["', '"]', "agg"];
  let text = String(item.name || item.question || id).replaceAll('"', "'");
  if (item.pivotal) text = `⭐ ${text}`;
  return `${mid(id)}${left}${text}${right}:::${cls}`;
}

export function renderEventStorming(model: Obj): string {
  const idx = indexModel(model);
  const it = (key: string) => items(model, key);
  const out = [
    `# Event Storming – ${model.domain ?? ""}`,
    "",
    "> Generated from `docs/domain/events.yaml` – **do not edit manually**.",
    "",
    "Legend: 🟧 Event · 🟦 Command · 🟪 Policy · 🟩 Read model · 🟨 Actor · 🩷 External system · 🟥 Hotspot · ⭐ Pivotal event",
    "",
  ];
  if (!it("events").length) {
    out.push("_No events captured yet. Start with `/event-storming`._", "");
    return out.join("\n");
  }

  const ctxOf = (id: string): string | undefined => {
    const item = idx.get(id) ?? {};
    return item.context ?? idx.get(item.aggregate ?? "")?.context;
  };

  // Big picture
  const lines = ["```mermaid", "flowchart LR"];
  const grouped = new Map<string | undefined, string[]>();
  for (const key of ["commands", "events"]) {
    for (const item of it(key)) {
      const ctx = ctxOf(item.id);
      grouped.set(ctx, [...(grouped.get(ctx) ?? []), item.id]);
    }
  }
  for (const [ctx, ids] of grouped) {
    if (ctx && idx.has(ctx)) {
      lines.push(`    subgraph ${mid(ctx)}["${idx.get(ctx)!.name}"]`);
      lines.push(...ids.map((i) => `        ${node(i, idx.get(i)!)}`));
      lines.push("    end");
    } else {
      lines.push(...ids.map((i) => `    ${node(i, idx.get(i)!)}`));
    }
  }
  for (const key of ["actors", "external_systems", "policies", "read_models"]) {
    lines.push(...it(key).map((item) => `    ${node(item.id, item)}`));
  }
  for (const c of it("commands")) {
    if (c.actor) lines.push(`    ${mid(c.actor)} --> ${mid(c.id)}`);
    for (const e of list(c.produces)) lines.push(`    ${mid(c.id)} --> ${mid(e)}`);
  }
  for (const p of it("policies")) {
    for (const e of list(p.when)) lines.push(`    ${mid(e)} --> ${mid(p.id)}`);
    for (const c of list(p.then)) lines.push(`    ${mid(p.id)} --> ${mid(c)}`);
  }
  for (const r of it("read_models")) {
    for (const e of list(r.fed_by)) lines.push(`    ${mid(e)} -.-> ${mid(r.id)}`);
    for (const a of list(r.used_by)) lines.push(`    ${mid(r.id)} -.-> ${mid(a)}`);
  }
  lines.push(CLASSDEFS, "```", "");
  out.push("## Big Picture", "", ...lines);

  // Flows
  if (it("flows").length) {
    out.push("## Flows", "");
    for (const f of it("flows")) {
      out.push(`### ${f.name}`, "");
      if (f.description) out.push(f.description, "");
      const seq = list(f.sequence).filter((i) => idx.has(i));
      out.push("```mermaid", "flowchart LR");
      out.push(...[...new Set(seq)].map((i) => `    ${node(i, idx.get(i)!)}`));
      out.push(...seq.slice(1).map((b, n) => `    ${mid(seq[n])} --> ${mid(b)}`));
      out.push(CLASSDEFS, "```", "");
    }
  }

  // Contexts & aggregates
  if (it("bounded_contexts").length) {
    out.push("## Bounded Contexts & Aggregates", "", "| Context | Purpose | Aggregates | Events |", "|---|---|---|---|");
    for (const bc of it("bounded_contexts")) {
      const aggs = it("aggregates").filter((a) => a.context === bc.id).map((a) => a.name);
      const evts = it("events").filter((e) => ctxOf(e.id) === bc.id).map((e) => e.name);
      out.push(`| ${bc.name} (\`${bc.id}\`) | ${bc.purpose ?? ""} | ${aggs.join(", ") || "–"} | ${evts.join(", ") || "–"} |`);
    }
    out.push("");
  }

  // Hotspots
  const hs = it("hotspots").filter((h) => (h.status ?? "open") === "open");
  if (hs.length) {
    out.push("## Open Hotspots", "");
    for (const h of hs) {
      const refs = list(h.refs);
      out.push(`- **${h.id}** – ${h.question}` + (refs.length ? ` _(refs: ${refs.join(", ")})_` : ""));
    }
    out.push("");
  }
  return out.join("\n");
}

export function writeEventStormingMd(model: Obj): string {
  writeFileSync(EVENT_STORMING_MD, renderEventStorming(model), "utf8");
  return EVENT_STORMING_MD;
}

// --------------------------------------------------------------------------
// Stories
// --------------------------------------------------------------------------
export interface Story {
  path: string;
  meta: Obj;
  body: string;
}

export const storyId = (s: Story): string => (typeof s.meta.id === "string" ? s.meta.id : "");

export function parseFrontmatter(path: string): { meta: Obj; body: string } {
  const text = readFileSync(path, "utf8").replaceAll("\r\n", "\n");
  if (!text.startsWith("---\n")) throw new Error("YAML frontmatter is missing (file must start with '---')");
  const end = text.indexOf("\n---", 4);
  if (end === -1) throw new Error("frontmatter is not closed with '---'");
  const meta = parseYaml(text.slice(4, end)) ?? {};
  if (!isType(meta, "object")) throw new Error("frontmatter must be an object");
  return { meta, body: text.slice(end + 4).replace(/^\n+/, "") };
}

export function storyFiles(): string[] {
  if (!existsSync(STORIES_DIR)) return [];
  return readdirSync(STORIES_DIR)
    .filter((n) => n.endsWith(".md") && !NON_STORY_FILES.has(n) && !n.startsWith("_"))
    .sort()
    .map((n) => join(STORIES_DIR, n));
}

/** Parses all story files; files with broken frontmatter end up in `failures`. */
export function loadStories(): { parsed: Story[]; failures: [string, string][] } {
  const parsed: Story[] = [];
  const failures: [string, string][] = [];
  for (const path of storyFiles()) {
    try {
      parsed.push({ path, ...parseFrontmatter(path) });
    } catch (e) {
      failures.push([path, e instanceof Error ? e.message : String(e)]);
    }
  }
  return { parsed, failures };
}

export function sections(body: string): Map<string, string> {
  const out = new Map<string, string>();
  let current: string | null = null;
  for (const line of body.split("\n")) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) {
      current = m[1].trim().toLowerCase();
      out.set(current, "");
    } else if (current !== null) {
      out.set(current, out.get(current) + line + "\n");
    }
  }
  return out;
}

export function section(secs: Map<string, string>, name: string): string | null {
  for (const [k, v] of secs) if (k.startsWith(name)) return v;
  return null;
}

export const SCENARIO_RE = /^\s*(?:Scenario Outline|Scenario Template|Scenario|Example)\s*:/m;

function checkBody(r: Report, where: string, meta: Obj, body: string): void {
  const secs = sections(body);
  const type = meta.type;
  if (type === "story") {
    const s = section(secs, "story");
    if (s === null) {
      r.error(where, "section '## Story' is missing");
    } else if (!/\bAs an?\b.+?\bI want\b.+?\b(so that|in order to)\b/is.test(s)) {
      r.error(where, "story sentence must have the form 'As a <role>, I want <goal>, so that <benefit>'");
    }
  }
  if (type === "spike" && section(secs, "question") === null) r.error(where, "spike needs a '## Question' section");
  if (type === "tech-task" && section(secs, "task") === null) r.error(where, "tech task needs a '## Task' section");

  const ac = section(secs, "acceptance criteria");
  if (ac === null) {
    r.error(where, "section '## Acceptance Criteria' is missing");
    return;
  }
  const scenarios = ac.split(SCENARIO_RE).slice(1);
  // Scenario titles become test titles (`ST-NNN: <scenario title>`), so they must be unique within a story
  const titles = scenarios.map((sc) => sc.split("\n")[0].trim().toLowerCase());
  const dupes = titles.filter((t, n) => t && titles.indexOf(t) !== n);
  if (dupes.length) r.error(where, `scenario titles must be unique within the story: ${[...new Set(dupes)].join(", ")}`);
  if (type === "story") {
    if (scenarios.length < 2) r.error(where, "at least 2 Gherkin scenarios required (happy path + error/edge case)");
    scenarios.forEach((sc, n) => {
      if (!/^\s*When\b/m.test(sc) || !/^\s*Then\b/m.test(sc)) {
        r.error(where, `scenario ${n + 1}: 'When' and 'Then' are required`);
      }
    });
  } else if (!scenarios.length && !/^\s*[-*]\s*\[[ xX]\]/m.test(ac)) {
    r.error(where, "give acceptance criteria as scenarios or a checklist ('- [ ] …')");
  }

  if (COMMITTED.has(meta.status) && body.includes("[OPEN]")) {
    r.error(where, `still contains [OPEN] markers, must not be '${meta.status}'`);
  }
}

/** Validates all stories. With `only`, findings are reported for that file only. */
/** The scenario titles of a story body, in order. */
export function scenarioTitlesIn(body: string): string[] {
  const ac = section(sections(body), "acceptance criteria") ?? "";
  const out: string[] = [];
  for (const line of ac.split("\n")) {
    const m = /^\s*(?:Scenario Outline|Scenario Template|Scenario|Example)\s*:\s*(.+?)\s*$/.exec(line);
    if (m) out.push(m[1]);
  }
  return out;
}

/**
 * What a story with a screen has not decided yet – the UX guidelines for the empty case, rejected input and
 * permission.
 *
 * These three gaps repeat across backlogs because nobody carries the list: stories introduce a screen with no
 * empty case, never say what a rejection does with what was typed, or let a person meet a wall instead of
 * removing the door. The validator should remember that, not a person.
 *
 * **Warnings, never errors, and a prompt to look rather than a verdict.** Each rule matches the wording stories
 * actually use, which means it both misses cases and names stories where the guideline does not apply (a story
 * whose screen has no list has no empty case to describe). Do not tune it against a particular backlog – that
 * fits the regex to one project instead of to the rule. The `ux-designer` in `/review-stories` reads for meaning
 * and stays the authority.
 */
export function completenessWarnings(story: Story): string[] {
  if (story.meta.type !== "story") return []; // spikes and tech tasks carry checklists, not screens
  if (!list(story.meta.labels).includes("ui")) return [];
  const ac = section(sections(story.body), "acceptance criteria") ?? "";
  if (!ac.trim()) return [];
  const titles = scenarioTitlesIn(story.body);
  const out: string[] = [];

  // G7 – the empty case, but only where there is something that can *be* empty. A `ui` story is often a single
  // action on a page another story owns (change a status, claim a record) and has no empty case of its own.
  const showsAList = /\b(listed|overview|dashboard)\b/i.test(ac);
  if (showsAList && !titles.some((t) => /\b(no|nothing|none|empty)\b/i.test(t))) {
    out.push("no scenario for the empty case – what does the screen show before anything exists? (UX guideline G7)");
  }

  // Judged per scenario, not per line: a permission rejection names the role in its Given and the refusal in
  // its Then, so a line-by-line check misses exactly the case G11 is about.
  const blocks = ac.split(/^(?=\s*(?:Scenario Outline|Scenario Template|Scenario|Example)\s*:)/m).filter((b) => b.trim());
  const rejections = blocks.filter((b) => /\breject(ed|s)?\b/i.test(b));
  // A rejection is about permission when the *role* is the point – not merely because a role is named, which
  // every scenario does ("When a technician registers …"). Otherwise G8 would never fire.
  const aboutPermission = (b: string) =>
    /\b(cannot|can not|may not|is not allowed|tries to|do(es)? not reach)\b/i.test(b) ||
    /^\s*Given\b.*\bis logged in\b/im.test(b);

  // G8 – a rejected form keeps what was typed. Skipped when every rejection is a permission rejection:
  // "a helper tries and is refused" has nothing typed to keep.
  if (rejections.length && !rejections.every(aboutPermission)) {
    if (!/\b(still (filled in|chosen|selected)|keeps what was typed|are still|is still)\b/i.test(ac)) {
      out.push("a rejection, but nothing says what happens to what was typed (UX guideline G8)");
    }
  }

  // G11 – someone who may not do a thing does not see the control, instead of meeting a wall.
  if (rejections.some(aboutPermission) && !/\b(not offered|not shown|does not see|is the only|only \S.{0,40}? offered)\b/i.test(ac)) {
    out.push("a permission rejection, but nothing says the control is not offered in the first place (UX guideline G11)");
  }
  return out;
}

export function validateStories(report: Report, only: string | null = null, lenientDeps = false): Map<string, Story> {
  const model = loadEventsModel();
  const idx = model ? indexModel(model) : null;
  if (model === null) report.warn(rel(EVENTS_FILE), "missing or invalid – event/context references are not checked");

  const onlyRes = only ? realPath(only) : null;
  const isMine = (path: string) => onlyRes === null || realPath(path) === onlyRes;

  const { parsed, failures } = loadStories();
  for (const [path, msg] of failures) if (isMine(path)) report.error(rel(path), msg);

  const counts = new Map<string, number>();
  for (const s of parsed) counts.set(storyId(s), (counts.get(storyId(s)) ?? 0) + 1);
  const stories = new Map<string, Story>();
  for (const s of parsed) if (storyId(s)) stories.set(storyId(s), s);
  const backlog = loadBacklogConfig();

  for (const s of parsed) {
    const r = isMine(s.path) ? report : new Report();
    const where = rel(s.path);
    const id = storyId(s);
    const m = s.meta;
    for (const e of schemaErrors(m, STORY_SCHEMA)) r.error(where, e);
    if (id && !basename(s.path, ".md").startsWith(id)) {
      r.error(where, `file name must start with '${id}' (e.g. ${id}-short-title.md)`);
    }
    if ((counts.get(id) ?? 0) > 1) r.error(where, `ID '${id}' is used more than once`);
    if (idx !== null) {
      const ctx = m.context;
      if (typeof ctx === "string" && ctx && (!idx.has(ctx) || prefix(ctx) !== "BC")) {
        r.error(where, `context '${ctx}' does not exist in events.yaml`);
      }
      for (const ev of list(m.events)) {
        if (!idx.has(ev) || prefix(ev) !== "EVT") r.error(where, `event '${ev}' does not exist in events.yaml`);
      }
    }
    for (const dep of list(m.depends_on)) {
      if (dep === id) {
        r.error(where, "depends on itself");
      } else if (!stories.has(dep)) {
        const msg = `depends_on '${dep}' does not exist`;
        if (lenientDeps) r.warn(where, msg);
        else r.error(where, msg);
      }
    }
    const status = m.status;
    if (COMMITTED.has(status) && !m.size) r.error(where, `size is missing – lead-dev must estimate before '${status}'`);
    if (m.size === "XL") {
      const msg = "size XL – split the story";
      if (COMMITTED.has(status)) r.error(where, msg);
      else r.warn(where, msg);
    }
    // Every scenario is a red → green cycle in /implement; past ten the story is too big or restates UX
    // guideline patterns (user, 2026-10-26). `ready` ones were approved under the older rules.
    const scenarioTotal = scenarioTitlesIn(s.body).length;
    if (m.type === "story" && scenarioTotal > MAX_SCENARIOS && (status === "draft" || status === "review")) {
      const msg = `${scenarioTotal} scenarios, at most ${MAX_SCENARIOS} – split the story, or reference the UX guideline (G-number) instead of restating its pattern as scenarios`;
      if (status === "review") r.error(where, msg);
      else r.warn(where, msg);
    }
    if (m.type === "story" && COMMITTED.has(status) && !list(m.events).length) {
      r.warn(where, "no domain events linked – traceability is missing");
    }

    // In tracker mode the Markdown file is a mirror. A story that is handed to engineering must carry its
    // external key, otherwise the next pull cannot match it and the tracker is not the source of truth any more.
    if (backlog.provider !== "local") {
      const ext = m.external;
      if (ext !== undefined) {
        if (ext === null || typeof ext !== "object" || ext.provider !== backlog.provider) {
          r.error(where, `external.provider must be '${backlog.provider}' – the configured backlog provider`);
        } else if (typeof ext.key !== "string" || !ext.key) {
          r.error(where, "external.key is missing");
        }
      }
      if (COMMITTED.has(status) && !(ext && typeof ext === "object" && typeof ext.key === "string" && ext.key)) {
        r.error(where, `not linked to the ${backlog.provider} backlog – run /backlog-sync push before '${status}'`);
      }
      const prefix = labelPrefix(backlog);
      for (const label of list(m.labels)) {
        if (isManagedLabel(label, prefix)) r.warn(where, `label '${label}' is reserved for the backlog sync`);
      }
    }

    checkBody(r, where, m, s.body);
    // Completeness is checked while a story is being written; `ready` ones were approved under the older rules
    // and are challenged in `/groom-backlog` instead (user, 2026-10-01).
    if (status === "draft" || status === "review") for (const w of completenessWarnings(s)) r.warn(where, w);
  }

  // Cycles in depends_on
  const state = new Map<string, 1 | 2>();
  const visit = (i: string, trail: string[]): void => {
    state.set(i, 1);
    for (const dep of list(stories.get(i)!.meta.depends_on)) {
      if (!stories.has(dep)) continue;
      if (state.get(dep) === 1) {
        const cyc = trail.includes(dep) ? [...trail.slice(trail.indexOf(dep)), dep] : [i, dep];
        if (cyc.some((c) => isMine(stories.get(c)!.path))) {
          report.error(rel(stories.get(i)!.path), `circular dependency: ${cyc.join(" → ")}`);
        }
      } else if (!state.has(dep)) {
        visit(dep, [...trail, dep]);
      }
    }
    state.set(i, 2);
  };
  for (const i of stories.keys()) if (!state.has(i)) visit(i, [i]);
  return stories;
}

// --------------------------------------------------------------------------
// Backlog (docs/stories/BACKLOG.md)
// --------------------------------------------------------------------------
const STATUS_TITLES: [string, string][] = [
  ["in-progress", "In Progress"],
  ["ready", "Ready"],
  ["review", "In Review"],
  ["draft", "Draft"],
  ["done", "Done"],
  ["superseded", "Superseded"],
];

/** Orders stories by priority, then id – but always after the stories they depend on. */
export function backlogOrder(group: Story[]): Story[] {
  const rank = (s: Story) => {
    const p = PRIORITIES.indexOf(s.meta.priority);
    return p === -1 ? PRIORITIES.length : p;
  };
  const sorted = [...group].sort((a, b) => rank(a) - rank(b) || storyId(a).localeCompare(storyId(b)));
  const byId = new Map(sorted.map((s) => [storyId(s), s]));
  const order: Story[] = [];
  const seen = new Set<Story>();
  const visit = (s: Story): void => {
    if (seen.has(s)) return;
    seen.add(s);
    for (const dep of list(s.meta.depends_on)) {
      const d = byId.get(dep);
      if (d) visit(d);
    }
    order.push(s);
  };
  sorted.forEach(visit);
  return order;
}

const cell = (v: unknown): string => (v === null || v === undefined || v === "" ? "–" : String(v).replaceAll("|", "\\|"));

export function renderBacklog(stories: Story[], model: Obj | null): string {
  const ctxNames = new Map<string, string>(
    (model ? items(model, "bounded_contexts") : []).map((bc) => [bc.id, bc.name]),
  );
  const byId = new Map(stories.map((s) => [storyId(s), s]));
  const out = [
    "# Backlog",
    "",
    "> Generated from `docs/stories/ST-*.md` – **do not edit manually**. Change the story files instead.",
    "",
  ];
  const backlog = loadBacklogConfig();
  if (backlog.provider !== "local") {
    const target = backlog.provider === "jira"
      ? `Jira (\`${backlog.jira.project || "project not configured"}\`)`
      : "GitHub Issues";
    out.push(
      `> Backlog backend: **${target}** – \`docs/stories/\` is the local mirror of the tracker. Sync with \`/backlog-sync\`.`,
      "",
    );
  }
  if (!stories.length) {
    out.push("_No stories yet. Derive them from the event storming with `@requirements-engineer`._", "");
    return out.join("\n");
  }

  const counts = STATUS_TITLES.map(([st, title]) => [title, stories.filter((s) => s.meta.status === st).length] as const);
  // Progress is measured in domain stories and their scenarios, not in the total number of stories (CLAUDE.md).
  // A superseded story was never built as one – its work counts where it was done.
  const domain = stories.filter((s) => s.meta.type === "story" && s.meta.status !== "superseded");
  const scenarioCount = (s: Story) =>
    (section(sections(s.body), "acceptance criteria") ?? "")
      .split("\n")
      .filter((line) => /^\s*(?:Scenario Outline|Scenario Template|Scenario|Example)\s*:/.test(line)).length;
  const doneDomain = domain.filter((s) => s.meta.status === "done");
  out.push(
    `**Progress: ${doneDomain.length} of ${domain.length} domain stories done** · ` +
      `scenarios ${doneDomain.reduce((n, s) => n + scenarioCount(s), 0)} of ${domain.reduce((n, s) => n + scenarioCount(s), 0)}`,
    "",
  );
  out.push(
    `**${stories.length} ${stories.length === 1 ? "story" : "stories"}** · ` +
      counts.map(([title, n]) => `${title}: ${n}`).join(" · "),
    "",
    "Within each section: by priority, then by story ID, with dependencies pulled in front. Open questions: [OPEN_QUESTIONS.md](OPEN_QUESTIONS.md)",
    "",
  );

  const known = new Set(STATUS_TITLES.map(([st]) => st));
  const groups: [string, Story[]][] = STATUS_TITLES.map(([st, title]) => [title, stories.filter((s) => s.meta.status === st)]);
  groups.push(["Invalid Status", stories.filter((s) => !known.has(s.meta.status))]);

  for (const [title, group] of groups) {
    if (!group.length) continue;
    out.push(`## ${title}`, "", "| ID | Title | Type | Context | Priority | Size | Risk | Depends on |", "|---|---|---|---|---|---|---|---|");
    for (const s of backlogOrder(group)) {
      const m = s.meta;
      const deps = list(m.depends_on).map((dep) => {
        const d = byId.get(dep);
        if (!d) return `${dep} (missing)`;
        return COMMITTED.has(d.meta.status) ? dep : `${dep} (${d.meta.status})`;
      });
      const ctx = typeof m.context === "string" ? ctxNames.get(m.context) ?? m.context : m.context;
      out.push(
        `| [${cell(storyId(s) || basename(s.path))}](${basename(s.path)}) | ${cell(m.title)} | ${cell(m.type)} | ${cell(ctx)} | ` +
          `${cell(m.priority)} | ${cell(m.size)} | ${cell(m.risk)} | ${deps.join(", ") || "–"} |`,
      );
    }
    out.push("");
  }
  return out.join("\n");
}

/** Regenerates BACKLOG.md from all parseable story files. */
export function writeBacklogMd(): string {
  writeFileSync(BACKLOG_MD, renderBacklog(loadStories().parsed, loadEventsModel()), "utf8");
  return BACKLOG_MD;
}
