/**
 * The gap register: the bridge between the as-is domain recovered from code and the target model.
 *
 * Every aggregate with `status: as-is` or `status: unresolved` gets one generated row. The row links the
 * aggregate in `events.yaml`, the as-is context map and the target context map, so a reader sees both sides of
 * the gap in one place. Decisions and manual gaps stay outside the managed block and survive a refresh.
 *
 * `docs/domain/context-map.md` is the target map; `docs/domain/context-map.as-is.md` is written by `/adopt`.
 * Missing files are not an error: a project that has not adopted anything yet has no gap register either.
 *
 * Node >= 22.18, erasable TypeScript only. No runtime dependency.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import * as d from "./discovery.ts";

export const GAP_REGISTER_FILE = "docs/domain/gap-register.md";
export const GAP_BEGIN = "<!-- kataster:gap-register:begin -->";
export const GAP_END = "<!-- kataster:gap-register:end -->";
export const AS_IS_CONTEXT_MAP = "docs/domain/context-map.as-is.md";
export const TARGET_CONTEXT_MAP = "docs/domain/context-map.md";

const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

export interface ContextEntry {
  id: string;
  heading: string;
  anchor: string;
}

export interface GapRegisterResult {
  path: string;
  status: "created" | "updated" | "unchanged" | "kept";
}

const cell = (value: unknown): string =>
  String(value ?? "").replaceAll("|", "\\|").replaceAll("\n", "<br>") || "–";

/** GitHub-style heading anchor, close enough for the context maps the skills write. */
export function headingAnchor(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .trim()
    .replace(/\s/g, "-");
}

/**
 * Reads `BC-…` headings from a context map. The heading may carry the display name after a dash:
 * `### BC-Order – Order` and `## BC-Order` both work.
 */
export function contextEntries(path: string): Map<string, ContextEntry> {
  const out = new Map<string, ContextEntry>();
  if (!existsSync(path)) return out;
  const text = readFileSync(path, "utf8");
  for (const line of text.split("\n")) {
    const match = /^(#{2,4})\s+(BC-[A-Za-z0-9]+)(?:\s+[–-]\s+(.+?))?\s*$/.exec(line);
    if (!match) continue;
    const heading = line.replace(/^#{2,4}\s+/, "").trim();
    out.set(match[2], { id: match[2], heading, anchor: headingAnchor(heading) });
  }
  return out;
}

function contextLink(file: string, entries: Map<string, ContextEntry>, id: string | undefined): string {
  if (!id) return "–";
  const entry = entries.get(id);
  // No heading means the context is not documented on this side yet – that is the gap, not a broken link.
  return entry ? `[${entry.id}](${basename(file)}#${entry.anchor})` : "–";
}

/** The generated rows. Kept separate from the rest of the file so refresh and --check share one renderer. */
export function renderGapBlock(model: d.Obj | null): string {
  const aggregates = model ? ((model.aggregates ?? []) as d.Obj[]) : [];
  const asIs = contextEntries(join(d.ROOT, AS_IS_CONTEXT_MAP));
  const target = contextEntries(join(d.ROOT, TARGET_CONTEXT_MAP));
  const openHotspots = model
    ? ((model.hotspots ?? []) as d.Obj[]).filter((h) => (h.status ?? "open") === "open")
    : [];
  const hotspotFor = (id: string): string | undefined =>
    openHotspots.find((h) => list(h.refs).includes(id))?.id;

  const rows: string[] = [
    GAP_BEGIN,
    "<!-- Generated from docs/domain/events.yaml by gap-register.ts. Do not edit inside this block. -->",
    "| Gap | Kind | Aggregate | As-is | Target | Evidence | Next step |",
    "|---|---|---|---|---|---|---|",
  ];

  for (const aggregate of aggregates) {
    const id = String(aggregate.id ?? "");
    const status = d.aggregateStatus(aggregate);
    if (status !== "as-is" && status !== "unresolved") continue;
    const slug = id.replace(/^AGG-/, "");
    const context = typeof aggregate.context === "string" ? aggregate.context : undefined;
    const hotspot = status === "unresolved" ? hotspotFor(id) : undefined;
    const targetLink = contextLink(TARGET_CONTEXT_MAP, target, context);
    const asIsLink = contextLink(AS_IS_CONTEXT_MAP, asIs, context);
    const evidence = list(aggregate.evidence).map(cell).join("<br>") || "–";
    const next =
      status === "unresolved"
        ? hotspot
          ? `Grill the boundary (${hotspot}); no story on it can be ready`
          : "Grill the boundary; add an open hotspot first"
        : targetLink === "–"
          ? "Decide the target boundary"
          : "Confirm the target boundary or keep it as-is";
    rows.push(
      `| GAP-AGG-${cell(slug)} | ${status === "as-is" ? "as-is boundary" : "unresolved boundary"} | ` +
        `[${id}](events.yaml) | ${asIsLink} | ${targetLink} | ${evidence} | ${next} |`,
    );
  }

  if (rows.length === 4) rows.push("| – | – | – | – | – | – | no as-is or unresolved aggregate yet |");
  rows.push(GAP_END);
  return rows.join("\n");
}

function emptyRegister(block: string): string {
  return [
    "# Gap register",
    "",
    "> Generated rows come from `docs/domain/events.yaml`; decisions and manual gaps live outside the managed block.",
    `> As-is map: [${basename(AS_IS_CONTEXT_MAP)}](${basename(AS_IS_CONTEXT_MAP)}) · Target map: [${basename(TARGET_CONTEXT_MAP)}](${basename(TARGET_CONTEXT_MAP)}).`,
    "",
    block,
    "",
    "## Decisions",
    "",
    "- none yet",
    "",
  ].join("\n");
}

function replaceBlock(existing: string, block: string): string | null {
  const start = existing.indexOf(GAP_BEGIN);
  const stop = existing.indexOf(GAP_END);
  if (start === -1 || stop === -1 || stop <= start) return null;
  return `${existing.slice(0, start)}${block}${existing.slice(stop + GAP_END.length)}`.replace(/\n{3,}/g, "\n\n");
}

/**
 * Writes or refreshes the managed block. With `onlyIfExists`, a missing register stays missing (used by the
 * PostToolUse hook, so a greenfield project is not given an empty artifact).
 */
export function writeGapRegister(options: { onlyIfExists?: boolean } = {}): GapRegisterResult | null {
  const path = join(d.ROOT, GAP_REGISTER_FILE);
  const model = d.loadEventsModel();
  const block = renderGapBlock(model);

  if (!existsSync(path)) {
    if (options.onlyIfExists) return null;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, emptyRegister(block), "utf8");
    return { path, status: "created" };
  }

  const existing = readFileSync(path, "utf8");
  const next = replaceBlock(existing, block);
  if (next === null) return { path, status: "kept" };
  if (next === existing) return { path, status: "unchanged" };
  writeFileSync(path, next, "utf8");
  return { path, status: "updated" };
}

export function checkGapRegister(): { ok: boolean; reason: string } {
  const path = join(d.ROOT, GAP_REGISTER_FILE);
  if (!existsSync(path)) return { ok: true, reason: "no gap register yet – /adopt creates it" };
  const existing = readFileSync(path, "utf8");
  const start = existing.indexOf(GAP_BEGIN);
  const stop = existing.indexOf(GAP_END);
  if (start === -1 || stop === -1 || stop <= start) {
    return { ok: true, reason: "the gap register has no managed block – treated as hand-written" };
  }
  const block = renderGapBlock(d.loadEventsModel());
  return replaceBlock(existing, block) === existing
    ? { ok: true, reason: "up to date" }
    : { ok: false, reason: "stale – run node .claude/skills/adopt/scripts/gap-register.ts" };
}
