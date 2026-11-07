---
name: user-stories
description: Rules, format and splitting patterns for stories, chores, tasks, spikes and tech tasks in docs/stories/ – frontmatter, the 1-command rule, three spec lenses, Gherkin, status workflow, the deterministic spec linter, and the local mirror when a Jira or GitHub tracker is configured.
---

# User Stories

The backlog is **local by default**: every story is a Markdown file in `docs/stories/`, and there is no external
issue tracker. With `backlog.provider` set to `github` or `jira` in `.claude/project.json`, the tracker is the source
of truth and `docs/stories/` is its local mirror – the `backlog` skill owns the sync. In both cases the story file is
the artifact this skill describes, and `docs/stories/BACKLOG.md` is generated from it by a hook – never edit it
manually.

## The spec engineer (main session)

There is no requirements subagent. The main session writes the stories, because it already holds the grilling, the
event storming and the user's decisions – handing them to another agent only adds friction and summary loss
(user, 2026-11-03).

While writing, hold **three lenses at once**:

1. **Domain** – is the behaviour unambiguous? One command, one actor, one observable outcome per scenario. No soft
   wording ("fast", "user-friendly"), no hidden second behaviour.
2. **Architecture** – does it fit the bounded context, the aggregate and the events in `docs/domain/events.yaml`?
   Does the command belong to the aggregate named in the story? Does it need a new event or invariant first?
3. **Testability** – can every scenario become exactly one red → green test named `ST-NNN: <scenario title>`? Is the
   *When* the real entry point and is every *Then* an assertion with a literal from the scenario?

If a lens fails, fix the model (`CONTEXT.md`, `events.yaml`, an ADR) before writing the story. A story that hides an
open decision is a story that will be decided in code.

## The 1-command rule

**One story = one command + the events it produces on one aggregate.** Do not merge several domain commands into one
story to "save a ticket"; that is what made stories unpredictable. A second command is a second story (or a
dependency), not a second scenario set.

Mechanically enforced by the linter for `type: domain`:

- `aggregate: AGG-…` and `command: CMD-…` are required and must exist in `events.yaml`;
- the command must belong to the stated aggregate;
- `events` must be exactly what that command produces – no more, no fewer;
- the aggregate must not be `status: unresolved` once the story leaves `review` – the boundary has to be settled
  in grilling first (a missing status means `target`, `as-is` is allowed).

**At most 4 Gherkin scenarios** per domain story: one happy path and up to three edge/error cases. More means the
story merges commands, restates a UX guideline pattern, or should be split.

## Derivation from the Event Storming
| Source in `events.yaml` | typically becomes |
|---|---|
| Actor + command → event | Story "As a <actor>, I want to <command>, so that <effect>" |
| Policy (automatic) | Story from the beneficiary's perspective ("… I am notified when …") |
| Read model | Story about finding/seeing information |
| Hotspot | Spike (question + timebox) or `[OPEN]` in the story |
| External system | Story or task for the integration |

Every domain story links the affected events (`events: [EVT-…]`). Commands without a story = gap → report it.

## File & Frontmatter
File: `docs/stories/ST-NNN-short-title.md` (three-digit number, consecutive, never reused).
Template: `templates/story-template.md`. Schema: `schema/story.schema.json`.

| Field | Required | Meaning |
|---|---|---|
| `id`, `title`, `type`, `status` | yes | identity and workflow state |
| `priority` (`must/should/could/wont`) | yes | backlog order; starts as `should` |
| `aggregate` (`AGG-…`), `command` (`CMD-…`) | for `type: domain` | the 1-command rule, cross-checked against `events.yaml` |
| `events` (`EVT-…`) | for `type: domain` | exactly the command's `produces` |
| `context` (`BC-…`) | for `type: domain` | the bounded context |
| `ui` (`true`) | no | story has a frontend part; triggers the on-demand UX utility |
| `size`, `risk`, `depends_on` | no | optional planning hints; no sizing gate |
| `labels` | no | lowercase, e.g. `mvp`, `feature:<slug>` |
| `external` | with a tracker | backlog sync – never by hand |

With `backlog.provider` = `github` or `jira`, `external` holds the tracker key (`external.key`) and URL. The sync writes
it; a story must have it before it reaches `ready`. `ST-NNN` stays the stable id – never renumber a story to follow an
issue key, and never use a label that starts with the management prefix (`kataster-` by default).

**No implementation foundation inside a domain story** (user, 2026-10-01). A story describes behaviour a person can
observe; technical groundwork that several stories need is its own `task`/`tech-task`, with its own `depends_on`.
A checklist of files to create, layers to convert or configs to set is an implementation plan, not acceptance
criteria – it is neither the user's language nor a testable outcome, and it hides the real size of the story.

## Types: domain, fast lane, tech task, spike

| `type` | Use for | Path in `/implement` |
|---|---|---|
| `domain` (default) | behaviour in the domain model: one command, one aggregate, Gherkin scenarios | full: TDD per scenario, traceability, diff-scaled review |
| `chore` | UI tweak, refactoring, dependency bump, small cleanup | fast lane: no Gherkin matching, no formal reviews |
| `task` | setup or a small non-domain change that is not a chore | fast lane (same as `chore`) |
| `tech-task` | deliberate technical groundwork several stories need, with a checklist | full: checklist evidence + acceptance tester |
| `spike` | a timeboxed question, checklist of what to answer | no TDD; evidence in the checklist |

`chore` and `task` have a `## Task` section and acceptance as a short checklist (`- [ ] …`) or, if they really have
observable behaviour, at most 4 scenarios. They do not need `aggregate`, `command`, `context` or `events`.

`story` is the legacy name of `domain` and still validates. The linter reports it as a warning and relaxes the strict rules
(missing `aggregate`/`command`, more than 4 scenarios) so an upgrade does not turn an existing backlog red – new work
uses `domain`.

## The `ui` flag

`ui: true` marks a story with a frontend part – a screen, a form, a flow a person walks through. It is the **only**
trigger for the on-demand `ux-designer`: component/layout proposals, Figma/design-token logic or a prototype. The UX
utility never gates the story; a missing decision comes back as a proposal, not as a blocker.

The old `labels: [ui]` is still recognised as equivalent. New stories set the flag.

## Status Workflow
`draft` (in progress) → `review` (written, waiting for the linter) → `ready-for-human-review` (spec linter green) →
`ready` (the user approved it) → `in-progress` → `done`.

- **The linter is the gate**: `node .claude/skills/user-stories/scripts/lint-story.ts <file>`. Only when it is green
  does the story move to `ready-for-human-review`; there is no LLM review pass before implementation. A warning
  about an `unresolved` aggregate is blocking for the gate: settle the boundary and its hotspot first.
- **`ready` is the user's decision**, not the agent's.
- Discovery ends at `ready`. The engineering workflow (`/implement`) sets `in-progress` and `done` with
  `node .claude/skills/implement/scripts/story-status.ts`; the validation hook enforces the same rules when the file
  is edited directly.
- `in-progress` and `done` need all `depends_on` stories `done`.
- `done` for a domain story needs a test titled `ST-NNN: <scenario title>` for every scenario; for a chore, task,
  tech task or spike every checklist item is ticked `- [x]`.
- A story that turns out wrong during implementation goes from `in-progress` (or `ready`) back to `review`, with
  `[OPEN]` + an entry in `OPEN_QUESTIONS.md`; the main session revises it and the linter/approval runs again.
- `done` is final. A change to finished behaviour is a new story.
- `superseded` – a story that is not built as written, before it was started: its work was done elsewhere (a direct
  change, another story), or a new planning replaces it. Set from `draft`, `review`, `ready-for-human-review` or
  `ready`, never from `in-progress`. Its first paragraph says where the work went or what replaces it; the file stays
  as the record other documents link to. Final like `done`, listed in its own section of the backlog and counted in
  no progress (user, 2026-10-25).

## Body Structure
```
## Story
As a <role from CONTEXT.md>, I want <goal>, so that <business benefit>.

## Context
Briefly: trigger, preconditions, business rules – from the command's `rules` **and from the `invariants` of its
aggregate**. An invariant is stated once, on the aggregate, and a command's `rules` list only what
it adds beyond them (`docs/domain/events.yaml`). So a command with few rules is not a command with
few rules to test: read its aggregate's `invariants` and give every one the command can violate its own rejection
scenario. "A product always has a name, a price and exactly one category" is why
`CMD-CorrectProduct` needs a scenario for an emptied name, although its `rules` do not mention it.

## Acceptance Criteria
Scenario: <Happy path>
  Given …
  When …
  Then …

Scenario: <Error or edge case>
  …

## Out of Scope
## Open Questions
```
Scenario titles are unique within a story and become test titles (`ST-NNN: <scenario title>`). Renaming a scenario
of an `in-progress` or `done` story breaks that link – the test must be renamed too (`verify.ts` reports it).

Chore/task/tech-task: `## Task`, `## Acceptance Criteria` (checklist `- [ ] …`).
Spike: `## Question`, `## Timebox`, `## Acceptance Criteria` (checklist).

## Quality Rules
- **INVEST**: independent, negotiable, valuable, estimable, small, testable.
- Gherkin in English (`Given / When / Then`); every scenario has all three steps. At least a happy path + one
  error/edge case, at most 4 scenarios.
- Scenarios describe **behavior**, not UI details ("clicks the blue button" ✗) and not technology.
- Spend the scenarios on domain behavior and real rejections. A pattern `docs/product/ux-guidelines.md` already
  defines (grouping, collapsing, kept choices after a rejection) is a G-number in the Context, tested once where the
  pattern is built, not restated as scenarios.
- Measurable outcomes: "Then the item has the status 'out of order'" instead of "Then it works".
- Non-functional requirements as concrete scenarios or checklist items with a number.
- Terms exactly as in the glossary `CONTEXT.md`; never use an `_Avoid_` synonym.

## Splitting Patterns (one command per story)
By command · by business rule · happy path first, special cases later · by data variant · by role ·
"manual first, automated later". If two commands share a screen, that is two stories and one `depends_on`, not one
story with two `When`s.

## Validation (deterministic, no LLM)
The spec linter is the gate before `ready-for-human-review`:

```bash
node .claude/skills/user-stories/scripts/lint-story.ts            # all stories
node .claude/skills/user-stories/scripts/lint-story.ts ST-012     # one story
kataster lint-story docs/stories/ST-012-*.md                      # from the CLI
```

It checks frontmatter syntax and required fields, the aggregate/command/event cross-check against
`docs/domain/events.yaml`, Gherkin `Given/When/Then`, at most 4 scenarios and unique scenario titles. A PostToolUse
hook runs the same rules after every write and regenerates `BACKLOG.md`; `verify.ts` runs them for the whole backlog.

After deleting or renaming story files, regenerate the backlog:
`node .claude/skills/user-stories/scripts/render-backlog.ts`

With a tracker, validation also refuses a `ready`, `in-progress` or `done` story without `external`, and warns about
labels reserved for the sync. Pull before validating a mirror that may be stale (`/backlog-sync pull`) and push after
changing it (`/backlog-sync push`).
