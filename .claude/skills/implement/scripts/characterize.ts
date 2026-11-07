/**
 * Finds the source files a story or a diff touches and checks whether a test exists for each of them.
 *
 *   node .claude/skills/implement/scripts/characterize.ts --story ST-012
 *   node .claude/skills/implement/scripts/characterize.ts --changed src/services/order-service.ts
 *   node .claude/skills/implement/scripts/characterize.ts --base origin/main --json
 *
 * This is a deterministic *test-presence* check, not a coverage tool: it finds tests by file-name convention
 * and by imports/references of the source. Whether a test covers the behaviour that is about to change is the
 * agent's judgement. When no test exists, /implement writes characterization tests first and commits them
 * separately, before the story's red → green loop.
 *
 * Exit 0 unless the arguments are wrong or the story does not exist; a missing test is a finding, not a crash.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import * as d from "../../../lib/discovery.ts";
import * as e from "../../../lib/engineering.ts";
import { readRepoMap, scanRepo, type RepoPackage } from "../../../lib/repo.ts";
import { packageForFile } from "../../../lib/slices.ts";

const args = process.argv.slice(2);

function usage(): void {
  console.log(
    [
      "Usage: node .claude/skills/implement/scripts/characterize.ts [options]",
      "",
      "  --story <ST-NNN>   find source files from the story's IDs, names and terms",
      "  --changed <file>   a file (repeatable or comma-separated); default: git status",
      "  --base <ref>       use the files changed against this ref",
      "  --json             machine-readable result",
    ].join("\n"),
  );
}

if (args.includes("--help") || args.includes("-h")) {
  usage();
  process.exit(0);
}

let storyId = "";
const changed: string[] = [];
let base = "";
for (let i = 0; i < args.length; i += 1) {
  const take = (): string | undefined => {
    const value = args[i + 1];
    if (!value || value.startsWith("--")) return undefined;
    i += 1;
    return value;
  };
  if (args[i] === "--story") storyId = (take() ?? "").toUpperCase();
  else if (args[i] === "--changed") {
    const value = take();
    if (value) changed.push(...value.split(",").map((f) => f.trim()).filter(Boolean));
  } else if (args[i] === "--base") base = take() ?? base;
}

if (!storyId && !changed.length && !base) {
  usage();
  process.exit(1);
}

const list = (v: unknown): string[] => (Array.isArray(v) ? v : []);
const read = (file: string): string => {
  try {
    return readFileSync(join(d.ROOT, file), "utf8");
  } catch {
    return "";
  }
};

const map = readRepoMap(d.ROOT) ?? scanRepo(d.ROOT, { toolGraph: false });
const pkgFor = (file: string): RepoPackage | undefined => packageForFile(map.packages, file);

const testFiles = e.projectFiles().filter(e.isTest);
const sourceFiles = e.projectFiles().filter((f) => e.isCode(f) && !e.isTestCode(f));

function changedFiles(): string[] {
  if (changed.length) return [...new Set(changed)];
  if (base) return (e.git("diff", "--name-only", base) ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  return (e.git("status", "--porcelain", "--untracked-files=all") ?? "")
    .split("\n")
    .map((line) => line.slice(3).trim().replace(/^.* -> /, ""))
    .filter(Boolean);
}

function testBase(file: string): string {
  return basename(file, extname(file))
    .replace(/^test_/, "")
    .replace(/(?:[._-](?:test|spec|tests|specs))$/i, "")
    .replace(/(?:Test|Tests|Spec|Specs|IT)$/i, "")
    .toLowerCase();
}

function testsFor(source: string): { file: string; reason: string }[] {
  const sourceBase = basename(source, extname(source)).toLowerCase();
  const out: { file: string; reason: string }[] = [];
  for (const test of testFiles) {
    const reason: string[] = [];
    if (testBase(test) === sourceBase) reason.push("same name");
    const text = read(test);
    // A reference to the module is enough evidence to look; it is not proof of behavioural coverage.
    if (sourceBase.length >= 3 && text.toLowerCase().includes(sourceBase)) reason.push("mentions the module");
    if (reason.length) out.push({ file: test, reason: reason.join(", ") });
  }
  return out;
}

function storySeedTerms(story: d.Story): { ids: string[]; names: string[]; words: string[] } {
  const ids = new Set<string>();
  const names = new Set<string>();
  const text = `${story.meta.title ?? ""}\n${story.body}`;
  for (const id of text.matchAll(/\b(?:ACT|EXT|BC|AGG|EVT|CMD|POL|RM)-[A-Za-z0-9]+\b/g)) ids.add(id[0]);
  for (const key of ["aggregate", "command", "context"]) {
    if (typeof story.meta[key] === "string") ids.add(story.meta[key]);
  }
  for (const id of list(story.meta.events)) ids.add(id);

  const model = d.loadEventsModel();
  if (model) {
    const idx = d.indexModel(model);
    for (const id of [...ids]) {
      const item = idx.get(id);
      if (typeof item?.name === "string") names.add(item.name);
    }
    for (const command of (model.commands ?? []) as d.Obj[]) {
      if (list(command.produces).some((event) => list(story.meta.events).includes(event))) {
        if (typeof command.name === "string") names.add(command.name);
      }
    }
  }

  const glossary = e.loadGlossary();
  for (const term of glossary.terms) {
    if (new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text)) names.add(term);
  }

  const stop = new Set(["story", "want", "that", "with", "from", "this", "when", "then", "given", "should", "must", "can", "the", "and", "for"]);
  const words = [...new Set(
    String(story.meta.title ?? "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length >= 4 && !stop.has(word)),
  )];
  return { ids: [...ids], names: [...names], words };
}

function scoreSource(file: string, terms: { ids: string[]; names: string[]; words: string[] }): { score: number; reasons: string[] } {
  const text = read(file).toLowerCase();
  const path = file.toLowerCase();
  let score = 0;
  const reasons: string[] = [];
  for (const id of terms.ids) {
    if (text.includes(id.toLowerCase())) {
      score += 3;
      reasons.push(`mentions ${id}`);
    }
  }
  for (const name of terms.names) {
    const lower = name.toLowerCase();
    if (lower.length >= 3 && new RegExp(`\\b${lower.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(text)) {
      score += 2;
      reasons.push(`mentions "${name}"`);
    }
  }
  for (const word of terms.words) {
    if (path.includes(word)) {
      score += 1;
      reasons.push(`path contains "${word}"`);
    }
  }
  return { score, reasons };
}

let story: d.Story | undefined;
const seeds = new Map<string, { file: string; score: number; reasons: string[] }>();
const warnings: string[] = [];

if (storyId) {
  try {
    story = e.findStory(storyId);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  const terms = storySeedTerms(story);
  for (const file of sourceFiles) {
    const scored = scoreSource(file, terms);
    if (scored.score > 0) seeds.set(file, { file, ...scored });
  }
  if (!seeds.size) warnings.push("no source file mentions the story's IDs or terms – pass --changed to name the affected paths");
}

for (const file of changedFiles()) {
  if (!existsSync(join(d.ROOT, file))) continue;
  if (!sourceFiles.includes(file)) continue;
  seeds.set(file, { file, score: seeds.get(file)?.score ?? 0, reasons: [...(seeds.get(file)?.reasons ?? []), "changed"] });
}

const sourceRows = [...seeds.values()]
  .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))
  .slice(0, 40)
  .map((seed) => {
    const tests = testsFor(seed.file);
    const pkg = pkgFor(seed.file);
    return {
      file: seed.file,
      package: pkg?.path,
      score: seed.score,
      reasons: seed.reasons,
      tests,
      covered: tests.length > 0,
      confidence: tests.some((test) => test.reason.includes("same name") || test.reason.includes("mentions the module")) ? "medium" : "low",
    };
  });

const storyTests = storyId
  ? testFiles.filter((file) => read(file).includes(storyId)).map((file) => ({ file, reason: `mentions ${storyId}` }))
  : [];
if (storyId && !storyTests.length) warnings.push(`no test mentions ${storyId} yet – expected before the story's red → green loop`);

const result = {
  story: story ? { id: storyId, title: story.meta.title, status: story.meta.status, type: story.meta.type } : null,
  seeds: [...seeds.values()].sort((a, b) => b.score - a.score || a.file.localeCompare(b.file)).slice(0, 40),
  sources: sourceRows,
  storyTests,
  warnings,
};

if (args.includes("--json")) {
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

console.log(`Characterization check${story ? ` – ${storyId}: ${story.meta.title}` : ""}`);
if (!sourceRows.length) {
  console.log("\nNo affected source file found. Name the paths with --changed, or widen the story terms.");
}
for (const row of sourceRows) {
  const status = row.covered ? "test found" : "NO TEST FOUND";
  console.log(`\n- ${row.file} (${row.package ?? "unmapped"}) – ${status}`);
  if (row.reasons.length) console.log(`  why: ${row.reasons.join("; ")}`);
  for (const test of row.tests) console.log(`  test: ${test.file} (${test.reason})`);
  if (!row.covered) console.log("  → write a characterization test first; pin the current behaviour, commit it separately, then start the story tests.");
}
if (storyTests.length) {
  console.log(`\nTests that mention ${storyId}:`);
  for (const test of storyTests) console.log(`- ${test.file} (${test.reason})`);
}
for (const warning of warnings) console.log(`\nWARNING ${warning}`);
console.log("\nA test file is evidence, not proof of behavioural coverage. If the current behaviour contradicts the story, the story goes back to review.");
