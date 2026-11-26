/**
 * Merge blockers: findings that are never settled with a default, never parked as an open question and never merged
 * – security and data protection (personal data exposed, authorization missing, injection), a 5xx answer to client
 * input, and an inconsistency that breaks a domain rule (a uniqueness that normalisation gets around). They block the
 * merge: a fix pass, the reviewer again, and when the blocker is still there, the story is escalated.
 *
 * Only the explicit tag blocks: `merge-blocker: <kind>`, written by a reviewer into the finding's row of its review
 * file. The text net below never blocks – it finds what *looks* like a merge blocker without the tag (a finding a
 * reviewer forgot to tag, a decision or an open question that may be one) and turns it into a warning and the
 * summary's "Possible merge blockers – please check" section for the user.
 *
 * Pure and dependency-free: the worker report (`lib/worker.ts`), the review step and the merge gate
 * (`lib/marathon.ts`) share it.
 */

export const MERGE_BLOCKER_KINDS = ["security", "privacy", "authorization", "injection", "server-error", "rule-bypass"] as const;
export type MergeBlockerKind = (typeof MERGE_BLOCKER_KINDS)[number];

/** What each kind means – the text the skills and reviewer agents point to. */
export const MERGE_BLOCKER_MEANING: Record<MergeBlockerKind, string> = {
  security: "a security weakness – secrets in code or logs, a missing CSRF check, path traversal",
  privacy: "personal data exposed – in a response, a log, an error message or to the wrong role",
  authorization: "a command or query that does not check who may run it",
  injection: "untrusted input that reaches a query, a shell, a template or HTML unescaped",
  "server-error": "a 5xx answer (or a crash) to input a client sent",
  "rule-bypass": "an inconsistency that breaks a domain rule – a uniqueness or invariant that normalisation, case or whitespace gets around",
};

/**
 * The net. Each check names the problem, not the area: "validates the e-mail address" is no blocker, "the e-mail
 * address is exposed" is; "loan IDs are unique" is none, "uniqueness compared after trimming" is. Order matters only
 * for the kind that is reported.
 */
const has = (re: RegExp) => (t: string): boolean => re.test(t);
const SAME_VALUE = /\b(?:unique|uniqueness|duplicates?|same (?:name|number|address|e-?mail))\b/i;
const NORMALISED = /\b(?:case|upper|lower|whitespace|spaces?|trim(?:s|med|ming)?|normali[sz](?:e|ed|es|ing|ation)|unicode|accents?)\b/i;
const CHECKS: [MergeBlockerKind, (text: string) => boolean][] = [
  ["injection", has(/\binjection\b|\bxss\b|\bcross[- ]site scripting\b|\bun(?:escaped|saniti[sz]ed)\b/i)],
  [
    "privacy",
    has(
      /\bpersonal(?:ly identifiable)? (?:data|information)\b|\bpii\b|\bprivacy\b|\bdata protection\b|\bgdpr\b|\b(?:e-?mail(?: address(?:es)?)?|names?|addresse?s?|phone numbers?)\b[^.;]{0,40}\b(?:exposed|leak(?:s|ed)?|visible to|shown to|logged)\b|\b(?:expos(?:es|ed|ing)|leak(?:s|ed|ing)?|logs?)\b[^.;]{0,30}\b(?:e-?mail(?: address(?:es)?)?|personal|phone numbers?|home address(?:es)?)\b/i,
    ),
  ],
  ["authorization", has(/\bauthori[sz](?:ation|e|ed|es|ing)\b|\bun(?:authori[sz]|authenticat)ed\b|\bauthenticat(?:e|ed|ion)\b|\baccess control\b|\bpermission check\b/i)],
  [
    "server-error",
    has(
      /\b5xx\b|\b(?:status|answers?|answered|returns?|returned|respon(?:ds?|ded|se)(?: with)?|throws?|gives?)\s+(?:an?\s+|with\s+)?(?:5\d\d|internal server error|server error)\b|\b5\d\d (?:status|response|error)\b|\binternal server error\b|\bunhandled (?:exception|error|rejection)\b|\bcrash(?:es|ed|ing)?\b/i,
    ),
  ],
  ["security", has(/\bsecurity\b|\bvulnerab(?:le|ility|ilities)\b|\bcsrf\b|\bpath traversal\b|\b(?:secrets?|credentials?|passwords?|(?:api |access )?tokens?)\b[^.;]{0,30}\b(?:in|into|to) (?:the )?(?:code|logs?|repo(?:sitory)?|responses?)\b/i)],
  [
    "rule-bypass",
    (t) =>
      (SAME_VALUE.test(t) && NORMALISED.test(t)) ||
      /\b(?:bypass(?:es|ed|ing)?|circumvent(?:s|ed|ing)?|get(?:s|ting)? around)\b/i.test(t) ||
      /\b(?:invariant|domain rule|business rule)\b[^.;]{0,40}\b(?:violat\w*|broken|breaks?|not (?:enforced|checked|held))\b/i.test(t) ||
      /\b(?:violat\w*|breaks?)\b[^.;]{0,20}\b(?:invariant|domain rule|business rule|uniqueness)\b/i.test(t),
  ],
];

const TAG = /\bmerge[- ]blocker\s*:\s*([a-z-]+)/gi;

const isKind = (k: string): k is MergeBlockerKind => (MERGE_BLOCKER_KINDS as readonly string[]).includes(k);

/** The kind a text tags (`merge-blocker: privacy`), or null. Only a tag blocks. */
export function taggedKind(text: string): MergeBlockerKind | null {
  for (const m of text.matchAll(TAG)) {
    const kind = m[1].toLowerCase();
    if (isKind(kind)) return kind;
  }
  return null;
}

/** The kind the text net recognises in an untagged text, or null. Never blocks – it asks for a look. */
export function suspectedKind(text: string): MergeBlockerKind | null {
  if (taggedKind(text)) return null;
  for (const [kind, check] of CHECKS) if (check(text)) return kind;
  return null;
}

/** How many findings a review file tags as merge blockers (`merge-blocker: <kind>`, one per table row or line). */
export function countTagged(reviewText: string): number {
  return reviewText.split("\n").filter((line) => taggedKind(line)).length;
}

/** Severity and recommendation cells that make a table row a finding (code review, acceptance edge cases). */
const FINDING_CELL = /^(?:blocker|major|minor|question|fix now)\b/i;

/**
 * Findings of a review file that look like merge blockers but carry no tag: table rows with a severity or a
 * "fix now / question" cell. Rows of other tables (scenarios, definition of done) are no findings.
 */
export function untaggedFindings(reviewText: string): { kind: MergeBlockerKind; text: string }[] {
  const out: { kind: MergeBlockerKind; text: string }[] = [];
  for (const line of reviewText.split("\n")) {
    const row = line.trim();
    if (!row.startsWith("|") || /^\|[\s:|-]+\|$/.test(row)) continue;
    const cells = row.split("|").map((c) => c.trim()).filter(Boolean);
    if (!cells.some((c) => FINDING_CELL.test(c))) continue;
    const kind = suspectedKind(row);
    if (kind) out.push({ kind, text: cells.join(" · ") });
  }
  return out;
}

export interface BlockerHit {
  /** Where it was found, e.g. `decisions[0]`. */
  where: string;
  kind: MergeBlockerKind;
  text: string;
}

function hits(lists: Record<string, readonly object[] | undefined>, kindOf: (text: string) => MergeBlockerKind | null): BlockerHit[] {
  const out: BlockerHit[] = [];
  for (const [name, list] of Object.entries(lists)) {
    (list ?? []).forEach((item, i) => {
      const text = Object.values(item as Record<string, unknown>).filter((v): v is string => typeof v === "string").join(" – ");
      const kind = kindOf(text);
      if (kind) out.push({ where: `${name}[${i}]`, kind, text });
    });
  }
  return out;
}

/** Entries that carry a merge-blocker tag – these block. */
export const taggedHits = (lists: Record<string, readonly object[] | undefined>): BlockerHit[] => hits(lists, taggedKind);

/** Untagged entries the net recognises – these are shown for a look, never blocking. */
export const suspectHits = (lists: Record<string, readonly object[] | undefined>): BlockerHit[] => hits(lists, suspectedKind);

const short = (text: string): string => (text.length > 120 ? `${text.slice(0, 117)}…` : text);
export const describeHit = (h: BlockerHit): string => `${h.where} (${h.kind}): ${short(h.text)}`;
