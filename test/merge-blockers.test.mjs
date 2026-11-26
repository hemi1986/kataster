import assert from "node:assert/strict";
import { test } from "node:test";
import { blockerHits, countTagged, MERGE_BLOCKER_KINDS, MERGE_BLOCKER_MEANING, mergeBlockerKind } from "../.claude/lib/merge-blockers.ts";

test("mergeBlockerKind names the problem, not the area", () => {
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
    for (const text of texts) assert.equal(mergeBlockerKind(text), kind, text);
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
  for (const text of ordinary) assert.equal(mergeBlockerKind(text), null, text);
});

test("a tag wins over the net; countTagged counts one per finding", () => {
  assert.equal(mergeBlockerKind("naming – merge-blocker: privacy"), "privacy");
  assert.equal(mergeBlockerKind("merge-blocker: nonsense"), null);
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

test("blockerHits looks through every text field and says where", () => {
  const hits = blockerHits({
    decisions: [{ question: "Order", decision: "by number", why: "convention" }, { question: "Body null", decision: "answers 500", why: "rare" }],
    openQuestions: [{ question: "May anyone retire a tool without authorization?", kind: "domain" }],
    notes: undefined,
  });
  assert.deepEqual(hits.map((h) => [h.where, h.kind]), [["decisions[1]", "server-error"], ["openQuestions[0]", "authorization"]]);
  for (const kind of MERGE_BLOCKER_KINDS) assert.ok(MERGE_BLOCKER_MEANING[kind]);
});
