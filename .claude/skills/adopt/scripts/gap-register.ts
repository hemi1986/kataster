/**
 * Writes or checks `docs/domain/gap-register.md` – one generated row per as-is or unresolved aggregate.
 *
 *   node .claude/skills/adopt/scripts/gap-register.ts          # create or refresh the managed block
 *   node .claude/skills/adopt/scripts/gap-register.ts --check  # exit 1 when the block is stale (advisory in verify)
 *   node .claude/skills/adopt/scripts/gap-register.ts --json
 *
 * Decisions and manual gaps live outside the managed block; a hand-written file without markers is left alone.
 * A missing register is not an error: a project that has not adopted anything yet has no gap register.
 */
import { checkGapRegister, writeGapRegister } from "../../../lib/gaps.ts";
import { rel, ROOT } from "../../../lib/discovery.ts";
import { join } from "node:path";

const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  console.log(
    [
      "Usage: node .claude/skills/adopt/scripts/gap-register.ts [--check|--json]",
      "",
      "  (no option)  create or refresh docs/domain/gap-register.md",
      "  --check      exit 1 when the generated block is stale",
      "  --json       machine-readable result",
    ].join("\n"),
  );
  process.exit(0);
}

if (args.includes("--check")) {
  const result = checkGapRegister();
  if (args.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.ok) {
    console.log(`OK – gap register: ${result.reason}.`);
  } else {
    console.error(`Gap register: ${result.reason}.`);
  }
  process.exit(result.ok ? 0 : 1);
}

try {
  const result = writeGapRegister();
  if (result === null) {
    console.log("No gap register written.");
    process.exit(0);
  }
  const path = rel(result.path);
  if (result.status === "created") console.log(`Created ${path}.`);
  else if (result.status === "updated") console.log(`Refreshed the generated block in ${path}.`);
  else if (result.status === "unchanged") console.log(`Kept ${path}: already up to date.`);
  else if (result.status === "kept") console.log(`Kept ${path}: it has no generated markers, so it is treated as hand-written.`);
  if (args.includes("--json")) console.log(JSON.stringify({ ...result, path: rel(result.path) }, null, 2));
  console.log(
    `As-is and target context maps: ${rel(join(ROOT, "docs", "domain", "context-map.as-is.md"))} / ` +
      `${rel(join(ROOT, "docs", "domain", "context-map.md"))}.`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
