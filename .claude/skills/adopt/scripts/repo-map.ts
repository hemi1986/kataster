/**
 * Builds the deterministic repository map that `/adopt` works from.
 *
 *   node .claude/skills/adopt/scripts/repo-map.ts              # write map + root AGENTS block
 *   node .claude/skills/adopt/scripts/repo-map.ts --json       # print the map, write nothing
 *   node .claude/skills/adopt/scripts/repo-map.ts --check      # exit 1 when the map is stale
 *   node .claude/skills/adopt/scripts/repo-map.ts --adopt <path>
 *
 * The map is generated from manifests and git history. It is not a domain model: it says where code lives,
 * how packages depend on each other and which slice to adopt first. Domain meaning comes from the grilling.
 */
import { ROOT, findPackage, markAdopted, packageCounts, proposeSlices, readRepoMap, scanRepo, stableMap, updateProjectTooling, writeRepoMap, writeRootBlock } from "../../../lib/repo.ts";
import { graphLabel, graphToolLabel } from "../../../lib/toolgraph.ts";

const args = process.argv.slice(2);
const root = ROOT;

function usage(): void {
  console.log(
    [
      "Usage: node .claude/skills/adopt/scripts/repo-map.ts [--json|--check|--adopt <path>]",
      "",
      "  (no option)     write docs/architecture/repo-map.{json,md} and the root AGENTS.md block",
      "  --json          print the map as JSON without writing",
      "  --check         exit 1 when the checked-in map no longer matches the repository",
      "  --adopt <path>  mark a package as adopted (after the grilling)",
      "  --no-tool-graph skip the build-tool graph query (Turbo/Nx/Bazel); manifest graph only",
    ].join("\n"),
  );
}

if (args.includes("--help") || args.includes("-h")) {
  usage();
  process.exit(0);
}

const adoptIndex = args.indexOf("--adopt");
if (adoptIndex !== -1) {
  const path = args[adoptIndex + 1];
  if (!path) {
    console.error("--adopt needs a package path, e.g. apps/billing");
    process.exit(1);
  }
  try {
    const map = markAdopted(root, path);
    const pkg = findPackage(map, path);
    console.log(`Adopted: ${pkg?.path ?? path}${pkg?.name ? ` (${pkg.name})` : ""}`);
    console.log("The root AGENTS.md block now lists it as adopted.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  process.exit(0);
}

const map = scanRepo(root, {
  // --check stays fast and environment-independent; the graph is enrichment, not part of the stable map.
  toolGraph: !args.includes("--check") && !args.includes("--no-tool-graph"),
});
// Refreshing the map must not forget which slices were already adopted.
const previous = readRepoMap(root);
if (previous) {
  for (const pkg of map.packages) {
    const old = previous.packages.find((p) => p.path === pkg.path);
    if (old?.adopted) {
      pkg.adopted = true;
      pkg.adoptedAt = old.adoptedAt;
    }
  }
}

if (args.includes("--json")) {
  console.log(JSON.stringify(map, null, 2));
  process.exit(0);
}

if (args.includes("--check")) {
  const existing = readRepoMap(root);
  if (!existing) {
    console.error("No docs/architecture/repo-map.json yet – run repo-map.ts once.");
    process.exit(1);
  }
  if (stableMap(existing) === stableMap(map)) {
    console.log("OK – the repository map matches the manifests.");
    process.exit(0);
  }

  const before = new Map(existing.packages.map((p) => [p.path, p]));
  const after = new Map(map.packages.map((p) => [p.path, p]));
  const added = [...after.keys()].filter((p) => !before.has(p));
  const removed = [...before.keys()].filter((p) => !after.has(p));
  const changed = [...after.keys()].filter((p) => before.has(p) && JSON.stringify(before.get(p)) !== JSON.stringify(after.get(p)));
  console.error("The repository map is stale – run `node .claude/skills/adopt/scripts/repo-map.ts` and review the diff.");
  if (added.length) console.error(`  added:   ${added.join(", ")}`);
  if (removed.length) console.error(`  removed: ${removed.join(", ")}`);
  if (changed.length) console.error(`  changed: ${changed.join(", ")}`);
  process.exit(1);
}

const written = writeRepoMap(root, map);
const profileUpdated = updateProjectTooling(root, map.tooling);
const agentsUpdated = writeRootBlock(root, map);
const proposal = proposeSlices(map);

console.log(`Repository map written: ${written.json.replace(`${root}/`, "")}, ${written.md.replace(`${root}/`, "")}`);
console.log(`Tooling: ${map.tooling.kind === "none" ? "none (single package)" : map.tooling.kind}${map.tooling.config ? ` (${map.tooling.config})` : ""}`);
if (map.toolGraph) {
  console.log(`Tool graph: ${graphLabel(map.toolGraph)}${map.toolGraph.task ? ` (${map.toolGraph.task})` : ""} – ${map.toolGraph.packages.length} package(s), ${map.toolGraph.edges.length} edge(s)`);
} else {
  const tool = graphToolLabel(map.tooling.kind);
  if (tool) console.log(`Tool graph: ${tool} graph not available – using the manifest graph`);
}
console.log(`Packages: ${map.packages.length} (${packageCounts(map)})`);
if (profileUpdated) console.log("Updated .claude/project.json → repo.tooling");
if (agentsUpdated) console.log("Updated the generated repository block in AGENTS.md");

if (proposal.domain) {
  console.log("");
  const label = proposal.domain.path === "." ? "root package" : proposal.domain.path;
  console.log(`Suggested first slice: ${label} (${proposal.domain.name})`);
  if (proposal.library) console.log(`  with shared library: ${proposal.library.path} (${proposal.library.name})`);
  console.log(`Mark it adopted after the grilling: node .claude/skills/adopt/scripts/repo-map.ts --adopt ${proposal.domain.path}`);
}
