/**
 * Research files (`docs/research/<topic>.md`) – evidence for cross-cutting decisions, not a specification.
 *
 * The researcher agent is read-only and returns structured findings. The main session writes them verbatim into a
 * research file with frontmatter: topic, question, created, retrieved, expires and the stack versions queried.
 * Expiry is computed when the file is written or refreshed (`retrieved + research.expiryMonths`), never on read.
 *
 * This module owns the format, the review gate and the status helpers. It does not import discovery.ts: discovery.ts
 * imports this module for story warnings, and a cycle would make both unreadable.
 *
 * Same rules as the rest of the payload: Node >= 22.18, erasable TypeScript only, one runtime dependency (`yaml`).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { loadResearchConfig, type Obj, type ResearchConfig } from "./config.ts";

export const ROOT = resolve(import.meta.dirname, "..", "..");
export const RESEARCH_DIR = join(ROOT, "docs", "research");

export type ResearchStatus = "valid" | "expired" | "missing" | "invalid";

/** Today's date in UTC, `YYYY-MM-DD`. */
export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TOPIC_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function isValidDate(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_RE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** `date` plus `months`, in UTC; a month-end date is clamped to the target month's last day. */
export function addMonths(date: string, months: number): string {
  const base = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(base.getTime())) throw new Error(`invalid date '${date}'`);
  const target = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + Math.trunc(months), 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  const day = Math.min(base.getUTCDate(), lastDay);
  return `${target.toISOString().slice(0, 7)}-${String(day).padStart(2, "0")}`;
}

/** Project-relative POSIX path for display; absolute when the file is outside the project. */
export function relPath(path: string): string {
  const r = relative(ROOT, path);
  return r.startsWith("..") || resolve(r) === r ? path : r.split(sep).join("/");
}

/** All research files: Markdown, no README, no `_`-prefixed drafts. */
export function researchFiles(): string[] {
  if (!existsSync(RESEARCH_DIR)) return [];
  return readdirSync(RESEARCH_DIR)
    .filter((name) => name.endsWith(".md") && name !== "README.md" && !name.startsWith("_"))
    .sort()
    .map((name) => join(RESEARCH_DIR, name));
}

export interface ResearchDocument {
  meta: Obj;
  body: string;
}

/** Parses a research file. Throws on a missing or broken frontmatter. */
export function parseResearchFile(path: string): ResearchDocument {
  const text = readFileSync(path, "utf8").replaceAll("\r\n", "\n");
  if (!text.startsWith("---\n")) throw new Error("YAML frontmatter is missing (file must start with '---')");
  const end = text.indexOf("\n---", 4);
  if (end === -1) throw new Error("frontmatter is not closed with '---'");
  const meta = parseYaml(text.slice(4, end)) ?? {};
  if (meta === null || typeof meta !== "object" || Array.isArray(meta)) {
    throw new Error("frontmatter must be an object");
  }
  return { meta: meta as Obj, body: text.slice(end + 4).replace(/^\n+/, "") };
}

export interface ResearchValidation {
  errors: string[];
  warnings: string[];
  doc: ResearchDocument | null;
}

const FINDING_FIELDS = ["Statement", "Source", "Retrieved", "Tier", "Confidence", "Domain-model impact"] as const;

/** Validates the persisted format. Expiry itself is a status, not a format error. */
export function validateResearchFile(path: string): ResearchValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  let doc: ResearchDocument;
  try {
    doc = parseResearchFile(path);
  } catch (error) {
    return { errors: [error instanceof Error ? error.message : String(error)], warnings, doc: null };
  }

  const meta = doc.meta;
  const topic = typeof meta.topic === "string" ? meta.topic : "";
  if (!topic) {
    errors.push("frontmatter: required field 'topic' is missing");
  } else if (!TOPIC_RE.test(topic)) {
    errors.push(`frontmatter: topic '${topic}' must be lowercase kebab-case`);
  } else if (basename(path, ".md") !== topic) {
    errors.push(`frontmatter: topic '${topic}' must match the file name '${basename(path)}'`);
  }

  if (typeof meta.question !== "string" || !meta.question.trim()) {
    errors.push("frontmatter: required field 'question' is missing or empty");
  }
  for (const field of ["created", "retrieved", "expires"] as const) {
    if (!isValidDate(meta[field])) {
      errors.push(`frontmatter: '${field}' must be a valid date (YYYY-MM-DD)`);
    }
  }
  if (!Array.isArray(meta.stack) || !meta.stack.every((entry) => typeof entry === "string")) {
    errors.push("frontmatter: 'stack' must be a list of version strings");
  }

  if (isValidDate(meta.created) && isValidDate(meta.retrieved) && meta.created > meta.retrieved) {
    errors.push("frontmatter: 'created' must not be after 'retrieved'");
  }
  if (isValidDate(meta.retrieved) && isValidDate(meta.expires) && meta.expires <= meta.retrieved) {
    errors.push("frontmatter: 'expires' must be after 'retrieved'");
  }

  if (!/^#\s+Research:\s*\S/m.test(doc.body)) {
    errors.push("body: heading '# Research: <topic>' is missing");
  }
  if (!/^##\s+Question\s*$/m.test(doc.body)) {
    errors.push("body: section '## Question' is missing");
  }
  if (!/^##\s+Findings\s*$/m.test(doc.body)) {
    errors.push("body: section '## Findings' is missing");
  }
  if (!/^##\s+Conflicts, caveats and gaps\s*$/m.test(doc.body)) {
    warnings.push("body: section '## Conflicts, caveats and gaps' is missing – state gaps or say that there are none");
  }
  if (!/^##\s+Open questions for the grilling\s*$/m.test(doc.body)) {
    warnings.push("body: section '## Open questions for the grilling' is missing");
  }

  const headings = [...doc.body.matchAll(/^###\s+(F\d+)\s*[–-]\s*(.*)$/gm)];
  if (!headings.length) {
    errors.push("body: at least one finding ('### F1 – <short claim>') is required");
  }
  for (const heading of headings) {
    const start = (heading.index ?? 0) + heading[0].length;
    const rest = doc.body.slice(start);
    const next = rest.search(/^###\s+/m);
    const block = next === -1 ? rest : rest.slice(0, next);
    for (const field of FINDING_FIELDS) {
      const value = new RegExp(`^-\\s*\\*\\*${field}:\\*\\*\\s*(.+)$`, "m").exec(block)?.[1].trim();
      if (!value) errors.push(`finding ${heading[1]}: field '${field}' is missing or empty`);
    }
    const tier = /^-\s*\*\*Tier:\*\*\s*(\S+)/m.exec(block)?.[1];
    if (tier && !/^[123]$/.test(tier)) errors.push(`finding ${heading[1]}: tier '${tier}' must be 1, 2 or 3`);
    const confidence = /^-\s*\*\*Confidence:\*\*\s*(\S+)/m.exec(block)?.[1]?.toLowerCase();
    if (confidence && !/^(high|medium|low)$/.test(confidence)) {
      errors.push(`finding ${heading[1]}: confidence '${confidence}' must be high, medium or low`);
    }
    const retrieved = /^-\s*\*\*Retrieved:\*\*\s*(\S+)/m.exec(block)?.[1];
    if (retrieved && !isValidDate(retrieved)) {
      errors.push(`finding ${heading[1]}: retrieved '${retrieved}' must be a valid date (YYYY-MM-DD)`);
    }
  }

  return { errors, warnings, doc };
}

export interface ResearchState {
  status: ResearchStatus;
  path: string;
  relPath: string;
  topic: string;
  question: string;
  retrieved: string;
  expires: string;
  errors: string[];
  warnings: string[];
}

/** Format and expiry of one research file. Expiry is compared against today, never recomputed from the config. */
export function researchStatus(path: string, now = today()): ResearchState {
  const base: ResearchState = {
    status: "missing",
    path,
    relPath: relPath(path),
    topic: basename(path, ".md"),
    question: "",
    retrieved: "",
    expires: "",
    errors: [],
    warnings: [],
  };
  if (!existsSync(path)) return base;

  const validation = validateResearchFile(path);
  const meta = validation.doc?.meta ?? {};
  const state: ResearchState = {
    ...base,
    topic: typeof meta.topic === "string" ? meta.topic : base.topic,
    question: typeof meta.question === "string" ? meta.question : "",
    retrieved: typeof meta.retrieved === "string" ? meta.retrieved : "",
    expires: typeof meta.expires === "string" ? meta.expires : "",
    errors: validation.errors,
    warnings: validation.warnings,
  };
  if (validation.errors.length) return { ...state, status: "invalid" };
  if (isValidDate(state.expires) && state.expires < now) return { ...state, status: "expired" };
  return { ...state, status: "valid" };
}

/** A local research reference: `docs/research/<topic>.md`, optionally with `#anchor`. */
export function isLocalResearchRef(ref: string): boolean {
  return /^docs\/research\/[A-Za-z0-9._-]+\.md(?:#.*)?$/.test(ref.trim());
}

/** A source is a web URL or a local research file. */
export function isValidSourceRef(ref: string): boolean {
  return /^https?:\/\/\S+$/i.test(ref.trim()) || isLocalResearchRef(ref);
}

/** Absolute path of a local research reference, without the anchor. */
export function researchPath(ref: string): string {
  return join(ROOT, ref.trim().split("#", 1)[0]);
}

/** The `sources:` entries of a story, as written. */
export function sourceRefs(meta: Obj): string[] {
  return Array.isArray(meta.sources)
    ? meta.sources.filter((value): value is string => typeof value === "string" && value.trim() !== "").map((value) => value.trim())
    : [];
}

/**
 * The gate: a story with one of the configured risks or labels needs research evidence before it leaves `review`.
 * Returns the trigger (`risk 'high'`, `label 'security:oauth'`, or both), or null when the story is not gated.
 * A label matches exactly or by prefix: `security` matches `security:oauth`.
 */
export function researchGateRequired(meta: Obj, cfg: ResearchConfig = loadResearchConfig()): string | null {
  const triggers: string[] = [];
  const risk = typeof meta.risk === "string" ? meta.risk.toLowerCase() : "";
  if (risk && cfg.gate.risk.includes(risk)) triggers.push(`risk '${risk}'`);

  const labels = Array.isArray(meta.labels)
    ? meta.labels.filter((value): value is string => typeof value === "string").map((value) => value.toLowerCase())
    : [];
  const matched = labels.find((label) =>
    cfg.gate.labels.some((configured) => label === configured || label.startsWith(`${configured}:`)),
  );
  if (matched) triggers.push(`label '${matched}'`);

  return triggers.length ? triggers.join(" / ") : null;
}

/**
 * Hard-gate errors for the transition to `ready-for-human-review` or `ready`.
 *
 * A source counts when it is `https://…` or a local `docs/research/<topic>.md`; a local file must exist. Expiry is
 * a warning elsewhere, never a gate error: an expired file still records where the evidence came from.
 */
export function researchGateErrors(meta: Obj, cfg: ResearchConfig = loadResearchConfig()): string[] {
  const trigger = researchGateRequired(meta, cfg);
  if (!trigger) return [];

  const sources = sourceRefs(meta);
  if (!sources.length) {
    return [`${trigger} requires at least one 'sources:' entry before ready-for-human-review`];
  }

  const valid = sources.filter(isValidSourceRef);
  if (!valid.length) {
    return [`${trigger} has no resolvable source – use https://… or docs/research/<topic>.md`];
  }
  if (valid.some((ref) => /^https?:\/\//i.test(ref))) return [];

  const local = valid.filter(isLocalResearchRef);
  const missing = local.filter((ref) => !existsSync(researchPath(ref)));
  if (local.length && missing.length === local.length) {
    return [`${trigger} has no resolvable source – missing: ${missing.join(", ")}`];
  }
  return [];
}

export interface ExpiredResearchRef {
  ref: string;
  path: string;
  relPath: string;
  expires: string;
}

/** Local research references of a story whose expiry has passed. Advisory: verify prints them, the gate does not. */
export function expiredResearchRefs(meta: Obj, cfg: ResearchConfig = loadResearchConfig(), now = today()): ExpiredResearchRef[] {
  void cfg;
  const out: ExpiredResearchRef[] = [];
  for (const ref of sourceRefs(meta).filter(isLocalResearchRef)) {
    const state = researchStatus(researchPath(ref), now);
    if (state.status === "expired") out.push({ ref, path: state.path, relPath: state.relPath, expires: state.expires });
  }
  return out;
}
