/**
 * Resolves a concept scope to candidate files across all layers.
 *
 *   node .claude/skills/adopt/scripts/slice.ts --paths "src/api/order*,src/services/order*,db/migrations/*order*"
 *   node .claude/skills/adopt/scripts/slice.ts --route "POST /orders"
 *   node .claude/skills/adopt/scripts/slice.ts --table orders
 *   node .claude/skills/adopt/scripts/slice.ts --event EVT-OrderPlaced
 *   node .claude/skills/adopt/scripts/slice.ts --cluster order
 *   node .claude/skills/adopt/scripts/slice.ts --term order
 *
 * The resolver follows imports in both directions, adds same-concept files from other layers and prints the
 * candidate set with reasons. It is evidence, not a verdict: `/adopt` confirms the scope with the user.
 */
import { readRepoMap } from "../../../lib/repo.ts";
import { resolveSlice, type EventLookup, type ResolveOptions } from "../../../lib/slices.ts";
import * as d from "../../../lib/discovery.ts";

const args = process.argv.slice(2);

function usage(): void {
  console.log(
    [
      "Usage: node .claude/skills/adopt/scripts/slice.ts <scope> [options]",
      "",
      "Scope (at least one):",
      "  --paths <glob>    a file glob (repeatable or comma-separated)",
      "  --route <route>   an entry point, e.g. 'POST /orders' or '/orders'",
      "  --table <name>    a table name from schema or code",
      "  --event <id>      an event, command or aggregate ID from events.yaml",
      "  --cluster <name>  a concept slice from the repository map",
      "  --term <word>     a domain term from file names or code",
      "",
      "Options:",
      "  --max-files <n>   cap the candidate set (default 200)",
      "  --depth <n>       import/reverse-import hops (default 2)",
      "  --json            machine-readable result",
    ].join("\n"),
  );
}

if (args.includes("--help") || args.includes("-h")) {
  usage();
  process.exit(0);
}

const options: ResolveOptions = { paths: [] };
let eventId = "";
for (let i = 0; i < args.length; i += 1) {
  const take = (): string | undefined => {
    const v = args[i + 1];
    if (!v || v.startsWith("--")) return undefined;
    i += 1;
    return v;
  };
  switch (args[i]) {
    case "--paths": {
      const v = take();
      if (v) options.paths!.push(...v.split(",").map((p) => p.trim()).filter(Boolean));
      break;
    }
    case "--route":
      options.route = take() ?? options.route;
      break;
    case "--table":
      options.table = take() ?? options.table;
      break;
    case "--event":
      eventId = take() ?? eventId;
      break;
    case "--cluster":
      options.cluster = take() ?? options.cluster;
      break;
    case "--term":
      options.term = take() ?? options.term;
      break;
    case "--max-files": {
      const v = Number(take());
      if (Number.isFinite(v) && v > 0) options.maxFiles = v;
      break;
    }
    case "--depth": {
      const v = Number(take());
      if (Number.isFinite(v) && v >= 0) options.depth = v;
      break;
    }
    default:
      break;
  }
}

if (eventId) {
  const model = d.loadEventsModel();
  if (model === null) {
    console.error("--event needs a readable docs/domain/events.yaml.");
    process.exit(1);
  }
  const idx = d.indexModel(model);
  const item = idx.get(eventId) ?? [...idx.entries()].find(([id]) => id.toLowerCase() === eventId.toLowerCase())?.[1];
  if (!item) {
    console.error(`'${eventId}' is not in events.yaml.`);
    process.exit(1);
  }
  const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const terms = new Set<string>();
  if (typeof item.name === "string") terms.add(item.name);
  if (typeof item.aggregate === "string") {
    terms.add(item.aggregate);
    const aggregate = idx.get(item.aggregate);
    if (typeof aggregate?.name === "string") terms.add(aggregate.name);
  }
  for (const command of (model.commands ?? []) as d.Obj[]) {
    if (!list(command.produces).includes(item.id)) continue;
    terms.add(String(command.id));
    if (typeof command.name === "string") terms.add(command.name);
  }
  const lookup: EventLookup = { id: item.id, terms: [...terms] };
  options.event = lookup;
}

const map = readRepoMap(d.ROOT);
if (!map) {
  console.error("No docs/architecture/repo-map.json yet – run `node .claude/skills/adopt/scripts/repo-map.ts` first.");
  process.exit(1);
}

const hasScope =
  Boolean(options.paths?.length) ||
  Boolean(options.route || options.table || options.event || options.cluster || options.term);
if (!hasScope) {
  usage();
  process.exit(1);
}

const result = resolveSlice(d.ROOT, map, options);
if (args.includes("--json")) {
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.seeds.length ? 0 : 1);
}

console.log(`Scope: ${result.query}`);
if (result.seeds.length) {
  console.log(`\nSeeds (${result.seeds.length}):`);
  for (const seed of result.seeds) console.log(`- ${seed.file} – ${seed.reasons.join("; ")}`);
} else {
  console.log("\nNo seed file found.");
}

if (result.files.length) {
  console.log(`\nCandidate files (${result.files.length}):`);
  for (const [layer, files] of Object.entries(result.byLayer)) {
    console.log(`\n## ${layer}`);
    for (const file of files) {
      const entry = result.files.find((candidate) => candidate.file === file);
      console.log(`- ${file} – ${entry?.reasons.join("; ") ?? ""}`);
    }
  }
}

for (const warning of result.warnings) console.log(`\nWARNING ${warning}`);
if (result.files.length) {
  console.log("\nThis is a candidate scope, not a verdict. Confirm it with the user before dispatching the analysts.");
}
process.exit(result.seeds.length ? 0 : 1);
