/**
 * Merge blockers: findings that are never settled with a default, never parked as an open question and never merged
 * – security and data protection (personal data exposed, authorization missing, injection), a 5xx answer to client
 * input, and an inconsistency that breaks a domain rule (a uniqueness that normalisation gets around). They block the
 * merge: a fix pass, the reviewer again, and when the blocker is still there, the story is escalated.
 *
 * Two ways in, both read here:
 *   - a reviewer tags the finding in its review file: `merge-blocker: <kind>` (the Area column);
 *   - the text of a decision, an open question or a skipped finding names one of them – the net under the rule, for
 *     a worker or an orchestrator that files a blocker as something else.
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

/** The kind a text names, or null. A tag (`merge-blocker: privacy`) wins over the net. */
export function mergeBlockerKind(text: string): MergeBlockerKind | null {
  for (const m of text.matchAll(TAG)) {
    const kind = m[1].toLowerCase();
    if ((MERGE_BLOCKER_KINDS as readonly string[]).includes(kind)) return kind as MergeBlockerKind;
  }
  for (const [kind, check] of CHECKS) if (check(text)) return kind;
  return null;
}

/** How many findings a review file tags as merge blockers (`merge-blocker: <kind>`, one per table row or line). */
export function countTagged(reviewText: string): number {
  let n = 0;
  for (const line of reviewText.split("\n")) {
    for (const m of line.matchAll(TAG)) {
      if ((MERGE_BLOCKER_KINDS as readonly string[]).includes(m[1].toLowerCase())) {
        n += 1;
        break;
      }
    }
  }
  return n;
}

export interface BlockerHit {
  /** Where it was found, e.g. `decisions[0]`. */
  where: string;
  kind: MergeBlockerKind;
  text: string;
}

/** The decisions and open questions (and anything else with text) that are merge blockers in disguise. */
export function blockerHits(lists: Record<string, readonly object[] | undefined>): BlockerHit[] {
  const hits: BlockerHit[] = [];
  for (const [name, list] of Object.entries(lists)) {
    (list ?? []).forEach((item, i) => {
      const text = Object.values(item as Record<string, unknown>).filter((v): v is string => typeof v === "string").join(" – ");
      const kind = mergeBlockerKind(text);
      if (kind) hits.push({ where: `${name}[${i}]`, kind, text });
    });
  }
  return hits;
}

export const describeHit = (h: BlockerHit): string => `${h.where} (${h.kind}): ${h.text.length > 120 ? `${h.text.slice(0, 117)}…` : h.text}`;
