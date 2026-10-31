import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_PRIORITY_MAP,
  DEFAULT_STATUS_MAP,
  labelPrefix,
} from "../.claude/lib/config.ts";
import {
  managedLabels,
  metaBlock,
  parseIssue,
  payloadHash,
  renderIssue,
  slugify,
} from "../.claude/lib/backlog.ts";

const github = {
  provider: "github",
  github: { repo: "", labelPrefix: "kataster" },
  jira: {
    mcpServer: "mcp-atlassian",
    project: "PROJ",
    issueType: "Story",
    labelPrefix: "kataster",
    statusMap: { ...DEFAULT_STATUS_MAP },
    priorityMap: { ...DEFAULT_PRIORITY_MAP },
  },
};

const jira = { ...github, provider: "jira" };

const story = {
  path: "/tmp/ST-001-place-an-order.md",
  meta: {
    id: "ST-001",
    title: "Place an order",
    type: "story",
    context: "BC-Order",
    priority: "must",
    size: "M",
    risk: "low",
    events: ["EVT-OrderPlaced"],
    depends_on: [],
    labels: ["mvp"],
    status: "draft",
  },
  body: "## Story\nAs a customer, I want to place an order, so that I get the goods.\n\n## Acceptance Criteria\n\nScenario: Order placed\n  Given a cart\n  When it is placed\n  Then it is recorded\n",
};

test("managed labels carry the facets and keep user labels", () => {
  const labels = managedLabels(story.meta, github);
  assert.ok(labels.includes("kataster"));
  assert.ok(labels.includes("kataster-status-draft"));
  assert.ok(labels.includes("kataster-priority-must"));
  assert.ok(labels.includes("kataster-type-story"));
  assert.ok(labels.includes("kataster-context-bc-order"));
  assert.ok(labels.includes("kataster-size-m"));
  assert.ok(labels.includes("kataster-risk-low"));
  assert.ok(labels.includes("mvp"));
  assert.equal(labelPrefix(github), "kataster");
});

test("GitHub issue round-trip: id, title, body and facets survive", () => {
  const payload = renderIssue(story, github);
  assert.equal(payload.title, "ST-001: Place an order");
  assert.match(payload.body, /<!-- kataster:story/);
  assert.ok(payload.body.startsWith(story.body.trim()));

  const remote = {
    key: "42",
    url: "https://github.com/acme/demo/issues/42",
    title: payload.title,
    body: payload.body,
    labels: payload.labels,
    state: "open",
  };
  const parsed = parseIssue(remote, github, { contexts: ["BC-Order"] });
  assert.equal(parsed.id, "ST-001");
  assert.equal(parsed.meta.title, "Place an order");
  assert.equal(parsed.meta.context, "BC-Order");
  assert.equal(parsed.meta.priority, "must");
  assert.equal(parsed.meta.size, "M");
  assert.equal(parsed.meta.risk, "low");
  assert.deepEqual(parsed.meta.events, ["EVT-OrderPlaced"]);
  assert.deepEqual(parsed.meta.labels, ["mvp"]);
  assert.equal(parsed.meta.status, "draft");
  assert.deepEqual(parsed.meta.external, {
    provider: "github",
    key: "42",
    url: "https://github.com/acme/demo/issues/42",
  });
  assert.equal(parsed.body, story.body.trim());
});

test("the tracker wins over the machine block for facets it owns", () => {
  const payload = renderIssue(story, github);
  const remote = {
    key: "42",
    title: payload.title,
    body: payload.body,
    labels: payload.labels.map((label) =>
      label === "kataster-priority-must" ? "kataster-priority-should" : label,
    ),
    state: "open",
  };
  assert.equal(parseIssue(remote, github).meta.priority, "should");
});

test("a closed GitHub issue is done; superseded keeps its status", () => {
  const payload = renderIssue(story, github);
  const closed = { key: "42", title: payload.title, body: payload.body, labels: payload.labels, state: "closed" };
  assert.equal(parseIssue(closed, github).meta.status, "done");
  const superseded = {
    ...closed,
    labels: payload.labels.map((label) =>
      label === "kataster-status-draft" ? "kataster-status-superseded" : label,
    ),
  };
  assert.equal(parseIssue(superseded, github).meta.status, "superseded");
});

test("Jira uses a fenced block and maps status and priority back", () => {
  const payload = renderIssue(story, jira);
  assert.match(payload.body, /```kataster-story/);
  const remote = {
    key: "PROJ-101",
    url: "https://example.atlassian.net/browse/PROJ-101",
    title: payload.title,
    body: payload.body,
    labels: payload.labels,
    status: "Ready",
    priority: "High",
  };
  const parsed = parseIssue(remote, jira, { contexts: ["BC-Order"] });
  assert.equal(parsed.meta.status, "ready");
  // The Jira priority field outranks the mirrored label.
  assert.equal(parsed.meta.priority, "should");
  assert.deepEqual(parsed.meta.external, {
    provider: "jira",
    key: "PROJ-101",
    url: "https://example.atlassian.net/browse/PROJ-101",
  });
});

test("Jira sanitizes labels on the issue and restores them from the machine block", () => {
  const withLabel = {
    ...story,
    meta: { ...story.meta, labels: ["feature:order-photos", "mvp"] },
  };
  const payload = renderIssue(withLabel, jira);
  assert.ok(payload.labels.includes("feature-order-photos"));
  assert.ok(!payload.labels.includes("feature:order-photos"));
  const remote = {
    key: "PROJ-1",
    title: payload.title,
    body: payload.body,
    labels: payload.labels,
    status: "Draft",
  };
  assert.deepEqual(parseIssue(remote, jira).meta.labels, ["feature:order-photos", "mvp"]);
  // A label removed in Jira goes, a label added there comes in.
  const changed = {
    ...remote,
    labels: [...payload.labels.filter((label) => label !== "mvp"), "urgent"],
  };
  assert.deepEqual(parseIssue(changed, jira).meta.labels, ["feature:order-photos", "urgent"]);
});

test("an issue without a machine block still becomes a story", () => {
  const remote = {
    key: "7",
    title: "ST-007: Imported issue",
    body: "## Story\nAs someone, I want this, so that it works.",
    labels: ["kataster", "kataster-status-review", "kataster-context-bc-order"],
    state: "open",
  };
  const parsed = parseIssue(remote, github, { contexts: ["BC-Order"] });
  assert.equal(parsed.id, "ST-007");
  assert.equal(parsed.meta.title, "Imported issue");
  assert.equal(parsed.meta.status, "review");
  assert.equal(parsed.meta.context, "BC-Order");
  assert.deepEqual(parsed.meta.labels, []);
});

test("a fallback id is used for issues without ST-NNN", () => {
  const remote = { key: "9", title: "Legacy issue", body: "## Story\nAs a user, I want it, so that it works.", labels: [], state: "open" };
  assert.equal(parseIssue(remote, github, { fallbackId: "ST-012" }).id, "ST-012");
  assert.equal(parseIssue(remote, github, { fallbackId: "ST-012" }).meta.title, "Legacy issue");
});

test("payload hashes are stable and label order independent", () => {
  const a = { title: "t", body: "b", labels: ["b", "a"], status: "draft" };
  const b = { title: "t", body: "b", labels: ["a", "b"], status: "draft" };
  assert.equal(payloadHash(a), payloadHash(b));
  assert.notEqual(payloadHash(a), payloadHash({ ...a, status: "ready" }));
});

test("meta block format follows the tracker", () => {
  assert.match(metaBlock(story.meta, "github"), /^<!-- kataster:story/);
  assert.match(metaBlock(story.meta, "jira"), /^```kataster-story/);
});

test("slugs are readable and bounded", () => {
  assert.equal(slugify("Place an order"), "place-an-order");
  assert.equal(slugify("Größe & Preis / 2"), "grosse-preis-2");
  assert.equal(slugify("!!!"), "story");
});
