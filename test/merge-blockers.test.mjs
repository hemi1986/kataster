import assert from "node:assert/strict";
import { test } from "node:test";
import { countTagged, MERGE_BLOCKER_KINDS, MERGE_BLOCKER_MEANING, suspectedKind, suspectHits, taggedHits, taggedKind, untaggedFindings } from "../.claude/lib/merge-blockers.ts";

test("suspectedKind: the net names the problem, not the area", () => {
  const blockers = {
    security: ["the API token is written into the logs", "a CSRF check is missing on the form", "path traversal through the file name"],
    privacy: ["the member list exposes every e-mail address", "personal data in the error message", "names of members are logged"],
    authorization: ["anyone can retire a tool – no authorization check", "the route runs unauthenticated"],
    injection: ["the search term goes into the query unescaped", "SQL injection through the sort parameter"],
    "server-error": ["a malformed body answers 500", "returns an internal server error for null", "null crashes the route", "the 5xx on {}"],
    "rule-bypass": [
      "e-mail uniqueness compared without lower case, so Ann@x.org and ann@x.org both register",
      "duplicate inventory numbers with trailing spaces",
      "a retired tool can be lent – the invariant is not enforced",
      "the check is bypassed through the HTTP route",
    ],
  };
  for (const [kind, texts] of Object.entries(blockers)) {
    for (const text of texts) assert.equal(suspectedKind(text), kind, text);
  }
  const ordinary = [
    "validates the e-mail address before storing it",
    "the inventory is exposed as GET /tools",
    "loan IDs are unique through journal.nextId",
    "names are stored as entered, trimmed only for the emptiness check",
    "a limit of 500 tools per page",
    "the list is sorted by inventory number",
    "422 through the existing invalid path",
  ];
  for (const text of ordinary) assert.equal(suspectedKind(text), null, text);
  // A tagged text is no suspect – it is a merge blocker.
  assert.equal(suspectedKind("a malformed body answers 500 – merge-blocker: server-error"), null);
});

test("only a tag makes a merge blocker; countTagged counts one per finding", () => {
  assert.equal(taggedKind("naming – merge-blocker: privacy"), "privacy");
  assert.equal(taggedKind("Merge-Blocker: Server-Error"), "server-error");
  assert.equal(taggedKind("merge-blocker: nonsense"), null);
  assert.equal(taggedKind("the member list exposes every e-mail address"), null, "the net never blocks");
  const review = [
    "| # | Severity | Area | File:line | Finding |",
    "|---|---|---|---|---|",
    "| 1 | blocker | merge-blocker: server-error | src/http/tool-routes.ts:12 | malformed JSON → 500 |",
    "| 2 | question | merge-blocker: rule-bypass, merge-blocker: privacy | src/lending/member/register.ts:8 | e-mail compared as entered |",
    "| 3 | minor | naming | src/x.ts:1 | helper name |",
    "| 4 | minor | merge-blocker: unknown | src/x.ts:2 | not a kind |",
  ].join("\n");
  assert.equal(countTagged(review), 2);
  assert.equal(countTagged("no findings"), 0);
});

test("untaggedFindings: finding rows that read like a merge blocker but carry no tag", () => {
  const review = [
    "## Definition of done",
    "| Item | Applies | Evidence | OK? |",
    "|---|---|---|---|",
    "| no personal data in logs | yes | no logging | OK |",
    "## Edge cases not covered by the story",
    "| Case | Expected by a rule? (cite) | Recommendation: fix now / question |",
    "|---|---|---|",
    "| body `null` answers 500 | conventions: Input and errors | fix now |",
    "| tool name of 300 characters | no rule | question |",
    "| `{}` crashes the route | conventions | fix now – merge-blocker: server-error |",
    "| 2 | major | design | src/x.ts:3 | the member list exposes every e-mail address | – | – |",
  ].join("\n");
  assert.deepEqual(untaggedFindings(review).map((f) => f.kind), ["server-error", "privacy"]);
  assert.match(untaggedFindings(review)[0].text, /^body `null` answers 500 · conventions: Input and errors · fix now$/);
});

test("taggedHits block, suspectHits only point – both say where", () => {
  const lists = {
    decisions: [
      { question: "Order", decision: "by number", why: "convention" },
      { question: "Body null", decision: "answers 500", why: "rare" },
      { question: "Body {}", decision: "answers 500 – merge-blocker: server-error", why: "copied from the review" },
    ],
    openQuestions: [{ question: "May anyone retire a tool without authorization?", kind: "domain" }],
    notes: undefined,
  };
  assert.deepEqual(taggedHits(lists).map((h) => [h.where, h.kind]), [["decisions[2]", "server-error"]]);
  assert.deepEqual(suspectHits(lists).map((h) => [h.where, h.kind]), [["decisions[1]", "server-error"], ["openQuestions[0]", "authorization"]]);
  for (const kind of MERGE_BLOCKER_KINDS) assert.ok(MERGE_BLOCKER_MEANING[kind]);
});
