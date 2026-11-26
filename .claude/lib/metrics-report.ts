/**
 * The metrics report – everything that is *derived* happens here, never in the stored entries:
 *
 *   - cost: raw tokens × `metrics.prices` in `.claude/project.json` (USD per million tokens, per model); a model
 *     without a price makes the cost unknown (–) and is listed as a warning
 *   - spec share: a feature's entries (`feature-<slug>.json`) are split across the stories that point to the
 *     feature (`feature: <slug>`, or the legacy `feature:<slug>` label), superseded stories excluded.
 *     **Key:** weight = number of Gherkin scenarios (domain stories) or acceptance checklist items (chore, task,
 *     tech task, spike). When every story has a weight > 0 the split is proportional to it; otherwise it is equal.
 *     A feature without stories stays undistributed.
 *   - size vs. actual: the stories' `size` against their total cost (own + spec share)
 */
import * as d from "./discovery.ts";
import * as e from "./engineering.ts";
import type { Entry, PriceTable, ReviewRecord, Tokens } from "./metrics.ts";
import { addTokens, costOf, featureSlug, isStoryTarget, loadPrices, metricsFiles, PHASES, priceFor, readMetricsFile, totalTokens, UNASSIGNED, zeroTokens } from "./metrics.ts";

export interface Sum {
  tokens: Tokens;
  /** null when at least one entry could not be priced. */
  costUsd: number | null;
  agentMs: number;
  userWaitMs: number;
  entries: number;
  passes: number;
}
const zeroSum = (): Sum => ({ tokens: zeroTokens(), costUsd: 0, agentMs: 0, userWaitMs: 0, entries: 0, passes: 0 });

function addSum(a: Sum, b: Sum, factor = 1): Sum {
  const scaled: Tokens = {
    input: b.tokens.input * factor,
    output: b.tokens.output * factor,
    reasoning: b.tokens.reasoning * factor,
    cacheRead: b.tokens.cacheRead * factor,
    cacheWrite: b.tokens.cacheWrite * factor,
    cacheWrite1h: b.tokens.cacheWrite1h * factor,
  };
  return {
    tokens: addTokens(a.tokens, scaled),
    costUsd: a.costUsd === null || b.costUsd === null ? null : a.costUsd + b.costUsd * factor,
    agentMs: a.agentMs + b.agentMs * factor,
    userWaitMs: a.userWaitMs + b.userWaitMs * factor,
    entries: a.entries + b.entries,
    passes: a.passes + b.passes,
  };
}

function sumEntries(entries: Entry[], prices: PriceTable, unpriced: Set<string>): Sum {
  let s = zeroSum();
  const passes = new Set<string>();
  for (const x of entries) {
    const cost = costOf(x.tokens, priceFor(prices, x.model, x.provider));
    if (cost === null) unpriced.add(x.provider && x.model ? `${x.provider}/${x.model}` : x.model ?? "?");
    passes.add(x.phase === UNASSIGNED ? x.key : x.key.split("|").slice(0, 6).join("|"));
    s = addSum(s, { tokens: x.tokens, costUsd: cost, agentMs: x.agentMs, userWaitMs: x.userWaitMs, entries: 1, passes: 0 });
  }
  return { ...s, passes: passes.size };
}

export interface StoryInfo {
  id: string;
  title: string;
  type: string;
  status: string;
  size: string | null;
  feature: string | null;
  weight: number;
}

function storyInfos(): Map<string, StoryInfo> {
  const out = new Map<string, StoryInfo>();
  for (const s of d.loadStories().parsed) {
    const id = d.storyId(s);
    if (!id) continue;
    const weight = d.isDomain(s.meta) ? d.scenarioTitlesIn(s.body).length : e.checklist(s).length;
    out.set(id, {
      id,
      title: String(s.meta.title ?? ""),
      type: String(s.meta.type ?? ""),
      status: String(s.meta.status ?? ""),
      size: typeof s.meta.size === "string" ? s.meta.size : null,
      feature: d.featureOf(s.meta),
      weight,
    });
  }
  return out;
}

export interface Distribution {
  feature: string;
  key: "scenarios/checklist" | "equal" | "none";
  sum: Sum;
  shares: { story: string; weight: number; fraction: number }[];
}

function distribute(feature: string, sum: Sum, stories: Map<string, StoryInfo>): Distribution {
  const members = [...stories.values()].filter((s) => s.feature === feature && s.status !== "superseded");
  if (!members.length) return { feature, key: "none", sum, shares: [] };
  const weighted = members.every((s) => s.weight > 0);
  const total = weighted ? members.reduce((n, s) => n + s.weight, 0) : members.length;
  return {
    feature,
    key: weighted ? "scenarios/checklist" : "equal",
    sum,
    shares: members.map((s) => ({ story: s.id, weight: s.weight, fraction: (weighted ? s.weight : 1) / total })),
  };
}

export interface ReportData {
  since: string | null;
  stories: {
    id: string;
    info: StoryInfo | null;
    own: Sum;
    unassigned: Sum;
    spec: Sum;
    total: Sum;
    phases: { phase: string; sum: Sum; models: string[] }[];
    /** Reviews recorded for the story (`story-metrics.ts review`), oldest first. */
    reviews: ReviewRecord[];
  }[];
  features: (Distribution & { phases: { phase: string; sum: Sum; models: string[] }[] })[];
  /** Entries no story or feature could be found for (`unassigned.json`). */
  orphan: Sum;
  sizes: { size: string; stories: number; meanCost: number | null; medianCost: number | null; meanTokens: number; meanAgentMs: number }[];
  /** Models that have no price in `metrics.prices` – their cost is unknown. */
  unpriced: string[];
  warnings: string[];
}

const phaseRank = (p: string): number => {
  const i = (PHASES as readonly string[]).indexOf(p);
  if (i !== -1) return i;
  if (p.startsWith("review-")) return (PHASES as readonly string[]).indexOf("fixes") - 0.5;
  return PHASES.length + 1;
};

function byPhase(entries: Entry[], prices: PriceTable, unpriced: Set<string>): { phase: string; sum: Sum; models: string[] }[] {
  const groups = new Map<string, Entry[]>();
  for (const x of entries) groups.set(x.phase, [...(groups.get(x.phase) ?? []), x]);
  return [...groups.entries()]
    .sort(([a], [b]) => phaseRank(a) - phaseRank(b) || a.localeCompare(b))
    .map(([phase, list]) => ({
      phase,
      sum: sumEntries(list, prices, unpriced),
      models: [...new Set(list.map((x) => x.model).filter((m): m is string => Boolean(m)))],
    }));
}

/** What a report covers. `extra` adds entries that are not in this checkout (a story branch that is not merged). */
export interface ReportOptions {
  story?: string;
  feature?: string;
  /** Only these stories (and the features they belong to). */
  stories?: string[];
  since?: string;
  extra?: { entries: Entry[]; reviews: { target: string; review: ReviewRecord }[] };
}

export function buildReport(opts: ReportOptions): ReportData {
  const warnings: string[] = [];
  const { prices, errors } = loadPrices();
  warnings.push(...errors);
  const since = opts.since ? Date.parse(opts.since) : null;
  if (opts.since && (since === null || Number.isNaN(since))) throw new Error(`--since '${opts.since}' is not a date (YYYY-MM-DD)`);

  const byTarget = new Map<string, Entry[]>();
  const reviewsOf = new Map<string, ReviewRecord[]>();
  const seen = new Set<string>();
  let unclosed = 0;
  const add = (x: Entry): void => {
    // An entry of an unmerged branch may be in this checkout as well once the branch is merged: count it once.
    const id = `${x.target}\0${x.key}`;
    if (seen.has(id) || (since !== null && Date.parse(x.start) < since)) return;
    seen.add(id);
    if (x.unclosed) unclosed += 1;
    byTarget.set(x.target, [...(byTarget.get(x.target) ?? []), x]);
  };
  const addReview = (target: string, r: ReviewRecord): void => {
    if (since !== null && Date.parse(r.at) < since) return;
    const list = reviewsOf.get(target) ?? [];
    if (!list.some((x) => x.key === r.key)) reviewsOf.set(target, [...list, r]);
  };
  for (const path of metricsFiles()) {
    const file = readMetricsFile(path);
    if (!file) continue;
    file.entries.forEach(add);
    for (const r of file.reviews ?? []) addReview(file.target, r);
  }
  opts.extra?.entries.forEach(add);
  for (const { target, review } of opts.extra?.reviews ?? []) addReview(target, review);
  const stories = storyInfos();
  const unpriced = new Set<string>();

  const features: ReportData["features"] = [];
  for (const [target, list] of byTarget) {
    const slug = featureSlug(target);
    if (!slug) continue;
    features.push({ ...distribute(slug, sumEntries(list, prices, unpriced), stories), phases: byPhase(list, prices, unpriced) });
  }
  const specOf = (id: string): Sum => {
    let s = zeroSum();
    for (const f of features) {
      const share = f.shares.find((x) => x.story === id);
      if (share) s = addSum(s, { ...f.sum, entries: 0, passes: 0 }, share.fraction);
    }
    return s;
  };

  const ids = new Set<string>([...byTarget.keys(), ...reviewsOf.keys()].filter(isStoryTarget));
  for (const f of features) for (const s of f.shares) ids.add(s.story);
  const storyRows: ReportData["stories"] = [...ids].sort().map((id) => {
    const list = byTarget.get(id) ?? [];
    const own = sumEntries(list.filter((x) => x.phase !== UNASSIGNED), prices, unpriced);
    const unassigned = sumEntries(list.filter((x) => x.phase === UNASSIGNED), prices, unpriced);
    const spec = specOf(id);
    const reviews = [...(reviewsOf.get(id) ?? [])].sort((a, b) => a.at.localeCompare(b.at));
    return { id, info: stories.get(id) ?? null, own, unassigned, spec, total: addSum(addSum(own, unassigned), spec), phases: byPhase(list, prices, unpriced), reviews };
  });

  const orphan = sumEntries(byTarget.get(UNASSIGNED) ?? [], prices, unpriced);

  const SIZE_ORDER = ["XS", "S", "M", "L", "XL", "–"];
  const sizes = SIZE_ORDER.map((size) => {
    const rows = storyRows.filter((r) => (r.info?.size ?? "–") === size && (r.total.entries > 0 || totalTokens(r.total.tokens) > 0));
    const costs = rows.map((r) => r.total.costUsd);
    const known = costs.every((c) => c !== null) ? (costs as number[]).sort((a, b) => a - b) : null;
    const mean = (xs: number[]) => (xs.length ? xs.reduce((n, x) => n + x, 0) / xs.length : 0);
    return {
      size,
      stories: rows.length,
      meanCost: known && known.length ? mean(known) : null,
      medianCost: known && known.length ? (known.length % 2 ? known[(known.length - 1) / 2] : (known[known.length / 2 - 1] + known[known.length / 2]) / 2) : null,
      meanTokens: mean(rows.map((r) => totalTokens(r.total.tokens))),
      meanAgentMs: mean(rows.map((r) => r.total.agentMs)),
    };
  }).filter((s) => s.stories > 0);

  if (unpriced.size) warnings.push(`no price in metrics.prices for: ${[...unpriced].sort().join(", ")} – their cost shows as –`);
  if (unclosed) warnings.push(`${unclosed} entries come from phases still open when their session ended (end = last activity)`);
  for (const f of features) if (f.key === "none") warnings.push(`feature:${f.feature} has no stories that point to it – its spec cost is not distributed`);

  let storyOut = storyRows;
  let featureOut = features;
  if (opts.story) storyOut = storyRows.filter((r) => r.id === opts.story);
  if (opts.stories) {
    const wanted = new Set(opts.stories);
    storyOut = storyRows.filter((r) => wanted.has(r.id));
    featureOut = features.filter((f) => f.shares.some((x) => wanted.has(x.story)));
  }
  if (opts.feature) {
    featureOut = features.filter((f) => f.feature === opts.feature);
    storyOut = storyRows.filter((r) => r.info?.feature === opts.feature);
  }
  return { since: opts.since ?? null, stories: storyOut, features: featureOut, orphan, sizes, unpriced: [...unpriced].sort(), warnings };
}

// --------------------------------------------------------------------------
// Rendering
// --------------------------------------------------------------------------
const n = (x: number): string => {
  const v = Math.round(x);
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 10_000) return `${(v / 1000).toFixed(0)}k`;
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
  return String(v);
};
const usd = (x: number | null): string => (x === null ? "–" : `$${x.toFixed(2)}`);
export function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

function table(head: string[], rows: string[][], right = new Set<number>()): string {
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]) => `| ${cells.map((c, i) => (right.has(i) ? c.padStart(widths[i]) : c.padEnd(widths[i]))).join(" | ")} |`;
  return [line(head), `|${widths.map((w, i) => (right.has(i) ? `${"-".repeat(w + 1)}:` : "-".repeat(w + 2))).join("|")}|`, ...rows.map(line)].join("\n");
}

const tokenCells = (s: Sum): string[] => [n(s.tokens.input), n(s.tokens.output), n(s.tokens.cacheRead), n(s.tokens.cacheWrite)];

function phaseTable(phases: { phase: string; sum: Sum; models: string[] }[], extra: { label: string; sum: Sum }[] = []): string {
  const rows = phases.map((p) => [p.phase, String(p.sum.passes), p.models.join(", ") || "–", ...tokenCells(p.sum), usd(p.sum.costUsd), duration(p.sum.agentMs), duration(p.sum.userWaitMs)]);
  for (const x of extra) rows.push([x.label, "", "", ...tokenCells(x.sum), usd(x.sum.costUsd), duration(x.sum.agentMs), duration(x.sum.userWaitMs)]);
  return table(["Phase", "Passes", "Models", "Input", "Output", "Cache read", "Cache write", "Cost", "Agent", "Wait"], rows, new Set([1, 3, 4, 5, 6, 7, 8, 9]));
}

/** The overview table: one row per story with its cost, tokens and times. */
export function storiesTable(rows: ReportData["stories"]): string {
  return table(
    ["Story", "Size", "Status", "Own", "Unassigned", "Spec share", "Total", "Tokens", "Agent", "Wait"],
    rows.map((s) => [
      s.id, s.info?.size ?? "–", s.info?.status ?? "?", usd(s.own.costUsd), usd(s.unassigned.costUsd), usd(s.spec.costUsd), usd(s.total.costUsd),
      n(totalTokens(s.total.tokens)), duration(s.total.agentMs), duration(s.total.userWaitMs),
    ]),
    new Set([3, 4, 5, 6, 7, 8, 9]),
  );
}

/** Reviews with their verdict and findings per severity; `story` adds the story column. */
export function reviewsTable(rows: { story?: string; review: Pick<ReviewRecord, "agent" | "verdict" | "blocker" | "major" | "minor" | "question" | "at"> }[]): string {
  const withStory = rows.some((r) => r.story);
  return table(
    [...(withStory ? ["Story"] : []), "Reviewer", "Verdict", "Blocker", "Major", "Minor", "Question", "Date"],
    rows.map(({ story, review: v }) => [...(withStory ? [story ?? ""] : []), v.agent, v.verdict.replaceAll("-", " "), String(v.blocker), String(v.major), String(v.minor), String(v.question), v.at.slice(0, 10)]),
    new Set(withStory ? [3, 4, 5, 6] : [2, 3, 4, 5]),
  );
}

export function renderReport(r: ReportData, opts: { story?: string; feature?: string }): string {
  const out: string[] = [];
  const title = opts.story ? `Metrics – ${opts.story}` : opts.feature ? `Metrics – feature:${opts.feature}` : "Metrics";
  out.push(`# ${title}${r.since ? ` (since ${r.since})` : ""}`, "");

  if (opts.story) {
    const s = r.stories[0];
    if (!s) {
      out.push(`No metrics for ${opts.story}.`);
    } else {
      out.push(`${s.info ? `${s.info.title} · ${s.info.type} · size ${s.info.size ?? "–"} · ${s.info.status}` : "story file not found"}`, "");
      const own = s.phases.filter((p) => p.phase !== UNASSIGNED);
      const extra = [{ label: UNASSIGNED, sum: s.unassigned }];
      const feat = s.info?.feature ? r.features.find((f) => f.feature === s.info!.feature) : undefined;
      const share = feat?.shares.find((x) => x.story === s.id);
      if (feat && share) extra.push({ label: `spec share (feature:${feat.feature}, ${feat.key}, ${(share.fraction * 100).toFixed(0)}%)`, sum: s.spec });
      extra.push({ label: "total", sum: s.total });
      out.push(phaseTable(own, extra), "");
      if (s.reviews.length) out.push("## Reviews", "", reviewsTable(s.reviews.map((review) => ({ review }))), "");
    }
  } else {
    if (r.stories.length) {
      out.push("## Stories", "", storiesTable(r.stories), "");
    }
    if (r.features.length) {
      out.push("## Features (spec cost)", "");
      out.push(
        table(
          ["Feature", "Stories", "Key", "Cost", "Tokens", "Agent", "Wait"],
          r.features.map((f) => [`feature:${f.feature}`, String(f.shares.length), f.key, usd(f.sum.costUsd), n(totalTokens(f.sum.tokens)), duration(f.sum.agentMs), duration(f.sum.userWaitMs)]),
          new Set([1, 3, 4, 5, 6]),
        ),
        "",
      );
      if (opts.feature) {
        for (const f of r.features) {
          out.push(phaseTable(f.phases), "");
          if (f.shares.length) {
            out.push(
              table(
                ["Story", "Weight", "Share", "Spec share"],
                f.shares.map((x) => [x.story, String(x.weight), `${(x.fraction * 100).toFixed(0)}%`, usd(f.sum.costUsd === null ? null : f.sum.costUsd * x.fraction)]),
                new Set([1, 2, 3]),
              ),
              "",
            );
          }
        }
      }
    }
    if (!opts.feature && r.orphan.entries) {
      out.push(`**Unassigned without a story** (\`unassigned.json\`): ${usd(r.orphan.costUsd)}, ${n(totalTokens(r.orphan.tokens))} tokens, agent ${duration(r.orphan.agentMs)}, wait ${duration(r.orphan.userWaitMs)}`, "");
    }
    if (r.sizes.length) {
      out.push("## Size vs. actual", "");
      out.push(
        table(
          ["Size", "Stories", "Ø cost", "Median cost", "Ø tokens", "Ø agent time"],
          r.sizes.map((s) => [s.size, String(s.stories), usd(s.meanCost), usd(s.medianCost), n(s.meanTokens), duration(s.meanAgentMs)]),
          new Set([1, 2, 3, 4, 5]),
        ),
        "",
      );
    }
    if (!r.stories.length && !r.features.length && !r.orphan.entries) out.push("No metrics yet – `docs/stories/metrics/` is empty.", "");
  }
  if (r.warnings.length) out.push("## Warnings", "", ...r.warnings.map((w) => `- ${w}`), "");
  return out.join("\n");
}
