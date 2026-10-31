# Concepts

The vocabulary the workflow uses, and why each piece exists.

## Grilling

An interview in **rounds**. The **frontier** is every decision whose prerequisites are settled – the questions that
can be asked now without guessing at answers you haven't heard. Each question is numbered and carries a recommended
answer, worded so that "yes" accepts it. Answers reshape the tree and push the frontier outward.

Two rules make it work:

- **Facts are the agent's job, decisions are the user's.** Files, code, docs, history – look it up. Never ask the
  user something you could find yourself.
- **Do not act until the frontier is empty** and the user confirms a shared understanding.

`/grill-me` is the pure form. `/grill-with-docs` adds the glossary and ADRs. Every discovery command embeds it.

## The artifacts

| Artifact | What it is | Who owns it |
|---|---|---|
| `CONTEXT.md` | Glossary – the ubiquitous language. One canonical word per concept, alternatives under `_Avoid_` | user, maintained by the agent |
| `docs/domain/events.yaml` | Event storming model: actors, contexts, aggregates, events, commands, policies, read models, hotspots, flows | user, written by the agent |
| `docs/domain/context-map.md` | Bounded contexts and their relationships (DDD patterns) | domain-architect |
| `docs/architecture/data-model.md` | Logical, stack-neutral model per aggregate; lifecycle and ER diagrams | domain-architect |
| `docs/engineering/conventions.md` | How code is built here, including the seam catalog | user |
| `docs/adr/` | Architecture decisions. `proposed` until the user accepts; accepted ones are superseded, never edited | user |
| `docs/stories/` | The backlog. One Markdown file per story; `BACKLOG.md` is generated. With a tracker, this is the local mirror | requirements-engineer, PO, lead-dev; `/backlog-sync` with a tracker |
| `docs/product/vision.md` | Problem, user groups, goals, non-goals, success criteria | user |
| `docs/product/ux-guidelines.md` | The interface yardstick, as numbered rules with date and reason | ux-designer, approved by user |

## Events, commands, aggregates

- An **event** is a business fact in the past tense: "Order placed". Not a button click, not "Record saved".
- A **command** is an intent that produces events: "Place order". It has an actor (or a policy) and rules.
- A **policy** is "whenever <event>, then <command>" – including time-triggered ones.
- A **read model** is what an actor needs to decide to send a command.
- An **aggregate** protects the invariants that must be consistent *immediately*. Everything else is eventually
  consistent via events and policies.
- An **invariant** is stated once, on the aggregate. A command's rules list only what it adds beyond them.

IDs are prefixed and stable: `ACT-`, `EXT-`, `BC-`, `AGG-`, `EVT-`, `CMD-`, `POL-`, `RM-`, `HS-`, `FLOW-`, `ST-`.
The code carries the same IDs, which is what makes traceability checkable.

## Stories

A story is a vertical slice of observable behaviour: `draft → review → ready → in-progress → done` (plus
`superseded`).

- **Discovery ends at `ready`.** Engineering moves `ready → in-progress → done`.
- **A story that turns out wrong goes back to `review`** with an `[OPEN]` and a row in `OPEN_QUESTIONS.md` – never
  guessed into shape during implementation.
- **`done` is final.** A change to finished behaviour is a new story.
- **At most 10 scenarios.** Each is one red → green cycle. More means split.
- **A scenario title becomes a test title**: `ST-NNN: <scenario title>`. `verify.ts` checks the link.

### Stories from tickets

`/feature` can start from an `ST-NNN`, a GitHub issue (`#123` or URL), a Jira key or a pasted ticket. The ticket is
**evidence, not a specification**: its acceptance criteria are grilled like any other claim, contradictions with the
model are findings, and the source is recorded in the story (`Source: …`). A bug gets one regression story with the
label `bug`; if the documented rule itself is wrong, it is a feature, because the rule changes. The intake is
read-only – it never writes stories, `external` links or sync state.

## Initiatives

An **initiative** is a proposal for an idea larger than one feature: a new service, a new bounded context, a
migration, a cross-context capability. `/shape` writes it to `docs/product/initiatives/<slug>.md` after the user
confirms the summary. It answers four questions: should we, where does it belong, what changes vs. what is new, and
what does it roughly cost. It ends with one recommendation: go, go with slice 1, spike first, needs discovery, park
or no-go.

An initiative is **not** a work item: no `ready`/`done`, no stories, no second backlog. The cost is always a range
with a basis and a confidence – an analogue service is evidence, not a template. Each accepted slice then goes
through `/feature`, which creates the stories and runs the review.

## The seam catalog

A **seam** is where a test attaches. Testing everything everywhere is not affordable, so the project agrees up front
which kind of code is tested at which seam – pure rule, command, read model, page. That catalog lives in
`docs/engineering/conventions.md`. `/implement` only stops for the user when a story needs a seam that is not in it.

## Review lanes

Review effort follows the risk of the diff, not a fixed checklist:

- **Light lane** – small, no domain events, no command, no migration, no input handling, no new dependency:
  acceptance tester only.
- **Normal lane** – code reviewer and acceptance tester in parallel, plus a bug-focused or security-focused pass when
  the diff touches shared platform code or input/auth/uploads.

## The acceptance verdict

The **acceptance tester decides** whether a story is done, not the user. The user reviews the pull request and
merges. That keeps one checkpoint with the user (merge) instead of two.

## Why a local mirror

One Markdown file per story, versioned with the code, validated by a hook, rendered into `BACKLOG.md`. The agent can
read and write it deterministically, and the domain model and the stories can be checked against each other.

That is the whole answer for `backlog.provider: "local"`. Teams that already work in a tracker get the same properties
with `"github"` or `"jira"`: the tracker is the source of truth, `docs/stories/` is a synchronized mirror, and the
mirror is what validation, test traceability and offline work run on. The story keeps its `ST-NNN` id; the tracker key
lives in `external`. Only the backlog core syncs – reviews and open questions stay local. The tracker wins a conflict;
the local file is backed up before it is overwritten.

GitHub syncs through `gh`; Jira through `mcp-atlassian`, because MCP is reachable only from the agent.
