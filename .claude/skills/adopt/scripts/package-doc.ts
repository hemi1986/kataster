/**
 * Writes or refreshes the per-package documentation that is loaded only when an agent works in that package.
 *
 *   node .claude/skills/adopt/scripts/package-doc.ts apps/billing
 *   node .claude/skills/adopt/scripts/package-doc.ts apps/billing --adopt
 *
 * It creates `<package>/AGENTS.md` (source of truth) and `<package>/CLAUDE.md` (`@AGENTS.md` for Claude Code).
 * The generated Facts block is refreshed on every run; the prose sections (Purpose, Key entities, External
 * interfaces, Typical pitfalls, Boundaries) are never touched. If an existing AGENTS.md has no generated
 * markers, the script leaves it alone and says so.
 */
import {
  ROOT, findPackage, markAdopted, readRepoMap, scanRepo, updateProjectTooling, writePackageDoc, writeRepoMap, writeRootBlock,
} from "../../../lib/repo.ts";

const args = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const adopt = process.argv.includes("--adopt");
const path = args[0];

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log("Usage: node .claude/skills/adopt/scripts/package-doc.ts <package-path> [--adopt]");
  process.exit(0);
}
if (!path) {
  console.error("Usage: node .claude/skills/adopt/scripts/package-doc.ts <package-path> [--adopt]");
  process.exit(1);
}

try {
  if (path === "." || path === "./" || path === "") {
    console.error("The root package is documented in AGENTS.md, not in a package file.");
    process.exit(1);
  }

  let map = readRepoMap(ROOT);
  if (!map) {
    map = scanRepo(ROOT);
    writeRepoMap(ROOT, map);
    updateProjectTooling(ROOT, map.tooling);
    writeRootBlock(ROOT, map);
    console.log("Wrote docs/architecture/repo-map.json and the root AGENTS.md block first (they were missing).");
  }

  const pkg = findPackage(map, path);
  if (!pkg) {
    const available = map.packages.map((p) => p.path).slice(0, 25).join(", ");
    console.error(`Package '${path}' is not in the repository map. Known packages: ${available}${map.packages.length > 25 ? ", …" : ""}`);
    process.exit(1);
  }

  const result = writePackageDoc(ROOT, map, pkg);
  const agentsRel = result.agents.replace(`${ROOT}/`, "");
  const claudeRel = result.claude.replace(`${ROOT}/`, "");

  if (result.status === "created") {
    console.log(`Created ${agentsRel} and ${claudeRel}`);
    console.log("Fill the [OPEN] sections in AGENTS.md during the grilling – do not invent domain meaning.");
  } else if (result.status === "refreshed") {
    console.log(`Refreshed the generated block in ${agentsRel}`);
  } else {
    console.log(`Kept ${agentsRel}: it has no generated markers, so it is treated as hand-written.`);
  }

  if (adopt) {
    markAdopted(ROOT, pkg.path);
    console.log(`Marked adopted: ${pkg.path}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
