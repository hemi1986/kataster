/**
 * Research file check – format and expiry.
 *
 *   node .claude/skills/research/scripts/research-check.ts --topic <slug>   # one file; exit 1 unless valid
 *   node .claude/skills/research/scripts/research-check.ts --referenced     # local sources: of all stories
 *   node .claude/skills/research/scripts/research-check.ts --all            # every file in docs/research/
 *   node .claude/skills/research/scripts/research-check.ts --json           # machine-readable
 *
 * Exit 0 = every checked file is valid; exit 1 = at least one needs a refresh or repair. `verify.ts` treats the
 * referenced check as advisory, so an expired file never fails the quality gate.
 */
import * as d from "../../../lib/discovery.ts";
import * as r from "../../../lib/research.ts";

interface CheckResult {
  status: r.ResearchStatus;
  path: string;
  relPath: string;
  topic: string;
  question: string;
  retrieved: string;
  expires: string;
  stories: string[];
  errors: string[];
  warnings: string[];
}

const args = process.argv.slice(2);
const json = args.includes("--json");
const topicArg = args.includes("--topic") ? args[args.indexOf("--topic") + 1] : undefined;

if (args.includes("--topic") && (!topicArg || topicArg.startsWith("--"))) {
  console.error("Usage: research-check.ts --topic <slug> | --referenced | --all [--json]");
  process.exit(1);
}

/** Local research files referenced by stories, with the story IDs. */
const referenced = new Map<string, string[]>();
for (const story of d.loadStories().parsed) {
  const id = d.storyId(story);
  for (const ref of r.sourceRefs(story.meta).filter(r.isLocalResearchRef)) {
    const path = r.researchPath(ref);
    referenced.set(path, [...new Set([...(referenced.get(path) ?? []), id].filter(Boolean))]);
  }
}

function check(path: string): CheckResult {
  const state = r.researchStatus(path);
  return { ...state, stories: referenced.get(path) ?? [] };
}

let paths: string[];
if (topicArg) {
  const slug = topicArg.replace(/\.md$/, "");
  const ref = `docs/research/${slug}.md`;
  if (!r.isLocalResearchRef(ref)) {
    console.error(`Invalid topic '${topicArg}' – use a lowercase kebab-case slug.`);
    process.exit(1);
  }
  paths = [r.researchPath(ref)];
} else if (args.includes("--all")) {
  paths = r.researchFiles();
  if (!paths.length) {
    if (json) console.log(JSON.stringify({ ok: true, results: [] }, null, 2));
    else console.log("No research files in docs/research/.");
    process.exit(0);
  }
} else {
  // No mode means the referenced files: the default a story review needs.
  paths = [...referenced.keys()].sort();
  if (!paths.length) {
    if (json) console.log(JSON.stringify({ ok: true, results: [] }, null, 2));
    else console.log("No stories reference a local research file.");
    process.exit(0);
  }
}

const results = paths.map(check);
const ok = results.every((result) => result.status === "valid");

if (json) {
  console.log(JSON.stringify({ ok, results }, null, 2));
} else {
  for (const result of results) {
    const detail: string[] = [];
    if (result.status === "expired") detail.push(`expired ${result.expires}`);
    else if (result.expires) detail.push(`expires ${result.expires}`);
    if (result.stories.length) detail.push(`referenced by ${result.stories.join(", ")}`);
    console.log(`${result.status.toUpperCase().padEnd(8)} ${result.relPath}${detail.length ? ` (${detail.join("; ")})` : ""}`);
    for (const error of result.errors) console.log(`  - ${error}`);
    for (const warning of result.warnings) console.log(`  ! ${warning}`);
  }
  if (ok) console.log(`\nResearch check OK – ${results.length} file(s).`);
  else {
    const counts = new Map<string, number>();
    for (const result of results.filter((entry) => entry.status !== "valid")) {
      counts.set(result.status, (counts.get(result.status) ?? 0) + 1);
    }
    console.log(
      `\nResearch check: ${[...counts].map(([status, n]) => `${n} ${status.toUpperCase()}`).join(", ")} – refresh or repair before relying on the findings.`,
    );
  }
}

process.exit(ok ? 0 : 1);
