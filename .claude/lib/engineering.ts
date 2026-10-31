/**
 * Shared, deterministic logic for the engineering workflow (`/implement`).
 *
 * Used by the scripts in .claude/skills/implement/scripts and by the hooks:
 *   - story selection and status transitions (ready → in-progress → done)
 *   - traceability between stories and code: test titles `ST-NNN: <scenario title>`,
 *     domain IDs (CMD-, EVT-, …) in the code, glossary language in code and message catalogs
 *   - the last result of `verify.ts`
 *
 * Builds on discovery.ts; same rules: Node >= 22.18, erasable TypeScript only.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import * as d from "./discovery.ts";

const list = (v: unknown): string[] => (Array.isArray(v) ? v : []);

// --------------------------------------------------------------------------
// Git
// --------------------------------------------------------------------------
export function git(...args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd: d.ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

/** Content of a project-relative file at HEAD, or null if it is not committed yet. */
export function headContent(relPath: string): string | null {
  return git("show", `HEAD:${relPath}`);
}

// --------------------------------------------------------------------------
// Stories
// --------------------------------------------------------------------------
export function storiesById(): Map<string, d.Story> {
  return new Map(d.loadStories().parsed.map((s) => [d.storyId(s), s]));
}

export function findStory(id: string): d.Story {
  const s = storiesById().get(id.toUpperCase());
  if (!s) throw new Error(`story '${id}' not found in docs/stories/`);
  return s;
}

/** Scenario titles from the story's acceptance criteria, in order. */
export const scenarioTitles = (story: d.Story): string[] => d.scenarioTitlesIn(story.body);

/** Checklist items (`- [ ] …`) of a spike or tech task. */
export function checklist(story: d.Story): { done: boolean; text: string }[] {
  const ac = d.section(d.sections(story.body), "acceptance criteria") ?? "";
  const out: { done: boolean; text: string }[] = [];
  for (const line of ac.split("\n")) {
    const m = /^\s*[-*]\s*\[([ xX])\]\s*(.+?)\s*$/.exec(line);
    if (m) out.push({ done: m[1] !== " ", text: m[2] });
  }
  return out;
}

/** The test title every scenario must have, exactly: `ST-NNN: <scenario title>`. */
export const testTitle = (id: string, scenario: string): string => `${id}: ${scenario}`;

// --------------------------------------------------------------------------
// Status workflow
// --------------------------------------------------------------------------
/**
 * Allowed single steps. Discovery owns draft/review/ready; engineering moves ready → in-progress → done
 * and sends a story back to review when it turns out to be wrong. `done` is final: changes to finished
 * behaviour become a new story.
 */
const TRANSITIONS: Record<string, string[]> = {
  draft: ["review", "superseded"],
  review: ["draft", "ready", "superseded"],
  ready: ["review", "in-progress", "superseded"],
  "in-progress": ["review", "done"],
  done: [],
  // Final like done: the record of a story done elsewhere or replaced by a new planning (user, 2026-10-25).
  superseded: [],
};

function reachable(from: string, to: string): boolean {
  const seen = new Set([from]);
  const queue = [from];
  while (queue.length) {
    for (const next of TRANSITIONS[queue.shift()!] ?? []) {
      if (next === to) return true;
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return false;
}

/**
 * Errors for moving `story` from status `from` to `to` (possibly over several steps, e.g. between two commits).
 * Checks the path through the workflow and the preconditions of the target status.
 */
export function transitionErrors(story: d.Story, from: string, to: string, stories: Map<string, d.Story>): string[] {
  if (from === to) return [];
  const errs: string[] = [];
  if (!reachable(from, to)) {
    errs.push(
      from === "done" || from === "superseded"
        ? `a ${from} story is never reopened – capture the change as a new story`
        : `status '${from}' cannot become '${to}' (workflow: draft → review → ready → in-progress → done, back to review when a story is wrong; superseded from any status before in-progress)`,
    );
    return errs;
  }
  if (to === "in-progress" || to === "done") {
    const open = list(story.meta.depends_on).filter((dep) => stories.get(dep)?.meta.status !== "done");
    if (open.length) errs.push(`depends on stories that are not done yet: ${open.join(", ")}`);
  }
  if (to === "done") {
    if (story.meta.type === "story") {
      const cov = scenarioCoverage(story);
      if (cov.missing.length) {
        errs.push(`scenarios without a test titled '${d.storyId(story)}: <scenario title>': ${cov.missing.map((m) => `"${m}"`).join(", ")}`);
      }
    }
    // Every checklist item must be ticked – for spikes and tech tasks, and for the foundation checklists a story
    // takes over just in time (e.g. "Foundation (moved from ST-074 …)").
    const open = checklist(story).filter((c) => !c.done);
    const short = (t: string) => (t.length > 60 ? `${t.slice(0, 57)}…` : t);
    if (open.length) errs.push(`${open.length} unticked acceptance criteria: ${open.map((c) => `"${short(c.text)}"`).join(", ")}`);
  }
  return errs;
}

/** Status of the story file at HEAD (null for a story that isn't committed yet). */
export function headStatus(story: d.Story): string | null {
  const text = headContent(d.rel(story.path));
  if (text === null) return null;
  const m = /^status:\s*(\S+)\s*$/m.exec(text.split("\n---")[0] ?? "");
  return m ? m[1] : null;
}

/** Rewrites the `status:` line in the story's frontmatter. */
export function writeStatus(story: d.Story, status: string): void {
  const text = readFileSync(story.path, "utf8");
  const end = text.indexOf("\n---", 4);
  const front = text.slice(0, end).replace(/^status:.*$/m, `status: ${status}`);
  writeFileSync(story.path, front + text.slice(end), "utf8");
}

/** Next story to implement: the first `ready` one in backlog order whose dependencies are all done. */
export function nextStory(): { inProgress: d.Story[]; next: d.Story | null; blocked: d.Story[] } {
  const stories = storiesById();
  const all = [...stories.values()];
  const inProgress = all.filter((s) => s.meta.status === "in-progress");
  const ready = d.backlogOrder(all.filter((s) => s.meta.status === "ready"));
  const depsDone = (s: d.Story) => list(s.meta.depends_on).every((dep) => stories.get(dep)?.meta.status === "done");
  return {
    inProgress,
    next: ready.find(depsDone) ?? null,
    blocked: ready.filter((s) => !depsDone(s)),
  };
}

// --------------------------------------------------------------------------
// Code scanning
// --------------------------------------------------------------------------
/** Not application code: tooling, docs, generated output, dependencies. */
const IGNORED_DIRS = new Set([
  ".git", ".claude", "docs", "node_modules", ".next", ".next-e2e", ".vercel", ".turbo", "coverage", "dist", "build", "out",
  "playwright-report", "test-results", "public",
]);
const CODE_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]);
const TEST_RE = /(\.(test|spec)\.[cm]?[jt]sx?$)|(^|\/)(e2e|__tests__)\//;
// Test stand-ins of a module (engineering conventions): test code, but not tests – they carry no scenario titles.
const TEST_SUPPORT_RE = /\.test-support\.[cm]?[jt]sx?$/;
const CATALOG_DIR_RE = /(^|\/)(messages|locales|i18n)\//;

export function projectFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (!IGNORED_DIRS.has(e.name)) walk(join(dir, e.name));
      } else if (e.isFile()) {
        out.push(d.rel(join(dir, e.name)));
      }
    }
  };
  walk(d.ROOT);
  return out.sort();
}

export const isCode = (f: string): boolean => CODE_EXT.has(extname(f)) && !f.endsWith(".d.ts");
export const isTest = (f: string): boolean => isCode(f) && TEST_RE.test(f);
/** Tests plus test stand-ins – excluded from the domain ID and language checks of application code. */
export const isTestCode = (f: string): boolean => isTest(f) || (isCode(f) && TEST_SUPPORT_RE.test(f));
export const isCatalog = (f: string): boolean => extname(f) === ".json" && CATALOG_DIR_RE.test(f);
const read = (f: string): string => readFileSync(join(d.ROOT, f), "utf8");

/** Every `ST-NNN: …` title found in string literals of test files, with its location. */
export function testTitles(): { title: string; file: string }[] {
  const out: { title: string; file: string }[] = [];
  const re = /(["'`])(ST-\d{3}: (?:(?!\1)[^\n])+?)\1/g;
  for (const f of projectFiles().filter(isTest)) {
    for (const m of read(f).matchAll(re)) out.push({ title: m[2].replace(/\s+/g, " ").trim(), file: f });
  }
  return out;
}

export function scenarioCoverage(story: d.Story, titles = testTitles()): { covered: string[]; missing: string[] } {
  const id = d.storyId(story);
  const found = new Set(titles.map((t) => t.title));
  const covered: string[] = [];
  const missing: string[] = [];
  for (const sc of scenarioTitles(story)) (found.has(testTitle(id, sc).replace(/\s+/g, " ")) ? covered : missing).push(sc);
  return { covered, missing };
}

/**
 * Scenarios of finished stories that a later story replaced (ST-094): `docs/stories/superseded-scenarios.json` maps a
 * story ID to its scenario titles and the story that superseded each. A done story is never reopened, but its
 * scenario can stop being true – its test is then removed together with the superseding story's change, and the
 * scenario is listed here instead, with the reason in that story's pull request. `check-scenarios.ts` accepts no test
 * for a listed scenario and refuses a stale entry.
 */
export const SUPERSEDED_SCENARIOS_FILE = "docs/stories/superseded-scenarios.json";

export function supersededScenarios(): Map<string, Map<string, string>> {
  const file = join(d.ROOT, SUPERSEDED_SCENARIOS_FILE);
  if (!existsSync(file)) return new Map();
  const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, Record<string, string>>;
  return new Map(Object.entries(raw).map(([id, scenarios]) => [id, new Map(Object.entries(scenarios))]));
}

/** Domain IDs (`CMD-ReportProblem`, `EVT-DefectRecorded`, …) used in application code (not tests). */
export function domainIdsInCode(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const re = /\b(?:ACT|EXT|BC|AGG|EVT|CMD|POL|RM)-[A-Z][A-Za-z0-9]+\b/g;
  for (const f of projectFiles().filter((f) => isCode(f) && !isTestCode(f))) {
    for (const m of read(f).matchAll(re)) out.set(m[0], [...new Set([...(out.get(m[0]) ?? []), f])]);
  }
  return out;
}

// --------------------------------------------------------------------------
// Glossary language
// --------------------------------------------------------------------------
/**
 * Words from `_Avoid_` lists that are ordinary programming vocabulary. They are only flagged in
 * user-facing text (message catalogs), never in code identifiers.
 */
const GENERIC_CODE_WORDS = new Set([
  "id", "type", "class", "kind", "state", "error", "format", "tag", "upload", "log", "schedule", "unit",
  "device", "place", "position", "slot", "lock", "note", "comment", "review", "check", "title", "file type",
]);

export interface Glossary {
  terms: string[];
  avoid: { word: string; preferred: string }[];
}

export function loadGlossary(): Glossary {
  const path = join(d.ROOT, "CONTEXT.md");
  const terms: string[] = [];
  const avoid: { word: string; preferred: string }[] = [];
  if (!existsSync(path)) return { terms, avoid };
  let current = "";
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = /^\*\*(.+?)\*\*:?\s*$/.exec(line);
    if (t) {
      current = t[1].replace(/:$/, "").trim();
      terms.push(current.toLowerCase());
      continue;
    }
    const a = /^_Avoid_:\s*(.+)$/.exec(line);
    if (a && current) {
      for (const raw of a[1].replace(/\([^)]*\)/g, "").split(",")) {
        const word = raw.trim().toLowerCase();
        if (word) avoid.push({ word, preferred: current });
      }
    }
  }
  return { terms, avoid };
}

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Avoided words in a piece of text; glossary terms are masked first, so "Problem report" doesn't flag "problem". */
export function avoidedWords(text: string, g: Glossary, inCode: boolean): { word: string; preferred: string }[] {
  let masked = ` ${text.toLowerCase()} `;
  for (const term of [...g.terms].sort((a, b) => b.length - a.length)) {
    masked = masked.replace(new RegExp(`\\b${esc(term)}s?\\b`, "g"), " ¤ "); // plural too: problemReports
  }
  const hits = g.avoid.filter(({ word }) => {
    if (g.terms.includes(word)) return false; // avoided in one place, the proper term elsewhere
    if (inCode && GENERIC_CODE_WORDS.has(word)) return false;
    return new RegExp(`\\b${esc(word)}s?\\b`).test(masked);
  });
  return [...new Map(hits.map((h) => [h.word, h])).values()];
}

/** `fooBarBaz`, `foo_bar`, `FooBar` → "foo bar baz". */
export const identifierWords = (id: string): string =>
  id.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").replace(/[_\-$]+/g, " ").toLowerCase();

export interface LanguageFinding {
  file: string;
  where: string;
  word: string;
  preferred: string;
}

/** Language of docs and stories, from the project profile (default English). */
function artifactLanguage(): string {
  try {
    const profile = JSON.parse(readFileSync(join(d.ROOT, ".claude", "project.json"), "utf8"));
    return String(profile.languages?.artifacts ?? "en").toLowerCase();
  } catch {
    return "en";
  }
}

export function languageFindings(): LanguageFinding[] {
  const g = loadGlossary();
  if (!g.avoid.length) return [];
  // Names from the event storming ("Report problem", "Triage list") are domain language too
  const model = d.loadEventsModel() ?? {};
  for (const key of ["events", "commands", "policies", "read_models", "aggregates"]) {
    for (const item of (model[key] ?? []) as d.Obj[]) if (typeof item.name === "string") g.terms.push(item.name.toLowerCase());
  }
  const out: LanguageFinding[] = [];
  const files = projectFiles();
  // User-facing text in the artifact language: message catalog values (other catalogs use the _UI (<lang>)_ words)
  const language = artifactLanguage();
  for (const f of files.filter((f) => isCatalog(f) && basename(f).toLowerCase().startsWith(language))) {
    let data: unknown;
    try {
      data = JSON.parse(read(f));
    } catch {
      continue;
    }
    const walk = (v: unknown, key: string): void => {
      if (typeof v === "string") {
        for (const h of avoidedWords(v, g, false)) out.push({ file: f, where: key, ...h });
      } else if (v && typeof v === "object") {
        for (const [k, c] of Object.entries(v)) walk(c, key ? `${key}.${k}` : k);
      }
    };
    walk(data, "");
  }
  // Identifiers declared in application code
  const decl = /\b(?:const|let|var|function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g;
  for (const f of files.filter((f) => isCode(f) && !isTestCode(f))) {
    const lines = read(f).split("\n");
    lines.forEach((line, n) => {
      if (line.includes("language-ok")) return; // explicit exception, e.g. a third-party `user` object
      for (const m of line.matchAll(decl)) {
        for (const h of avoidedWords(identifierWords(m[1]), g, true)) out.push({ file: f, where: `line ${n + 1}: ${m[1]}`, ...h });
      }
    });
  }
  return out;
}

// --------------------------------------------------------------------------
// Verify state (read by the SessionStart hook)
// --------------------------------------------------------------------------
const STATE_FILE = join(d.ROOT, ".claude", "state", "last-verify.json");

export interface VerifyState {
  at: string;
  branch: string | null;
  commit: string | null;
  dirty: boolean;
  ok: boolean;
  steps: { name: string; ok: boolean; skipped?: boolean }[];
}

export function writeVerifyState(state: VerifyState): void {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n", "utf8");
}

export function readVerifyState(): VerifyState | null {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return null;
  }
}

// --------------------------------------------------------------------------
// Application tooling (root package.json – created by ST-001)
// --------------------------------------------------------------------------
export function appScripts(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(join(d.ROOT, "package.json"), "utf8")).scripts ?? {};
  } catch {
    return {};
  }
}

/** Path of a binary in the app's node_modules/.bin, or null if not installed. */
export function appBin(name: string): string | null {
  const p = join(d.ROOT, "node_modules", ".bin", name);
  return existsSync(p) ? p : null;
}
