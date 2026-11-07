# Stories

One Markdown file per story: `ST-NNN-short-title.md`. `BACKLOG.md` is generated – never edit it by hand.
Rules, format and splitting: `.claude/skills/user-stories/SKILL.md`.
Template: `.claude/skills/user-stories/templates/story-template.md`.

Workflow: `draft → review → ready-for-human-review → ready → in-progress → done` (plus `superseded`).

- The **spec linter** is the gate: `node .claude/skills/user-stories/scripts/lint-story.ts <file>` (or
  `kataster lint-story`). It checks frontmatter, `aggregate`/`command`/events against `docs/domain/events.yaml`,
  Gherkin `Given/When/Then` and the scenario limit – deterministically, no LLM.
- Green → `ready-for-human-review`; **the user approves `ready`**. `/implement` only picks up `ready`.
- **1-command rule:** one `type: domain` story = one command + its events on one aggregate, at most 4 scenarios.
- An aggregate with `status: unresolved` blocks the story at `ready-for-human-review`; settle the boundary and
  its hotspot in grilling first. A missing status means `target`; `as-is` is allowed.
- **Fast lane:** `type: chore` or `type: task` for UI tweaks, refactorings, dependencies and setup – no Gherkin
  matching, no formal reviews. `type: tech-task` keeps its checklist; `type: spike` is a timeboxed question.
- `ui: true` marks a story with a frontend part; it triggers the on-demand UX utility, never a gate.
- A story that turns out wrong goes back to `review` with an `[OPEN]` and a row in `OPEN_QUESTIONS.md`.
- `done` is final: a change to finished behaviour is a new story.

## Backlog backend

`docs/stories/` is the backlog when `.claude/project.json` has `backlog.provider: "local"` (the default). With
`"github"` or `"jira"`, the tracker is the source of truth and this directory is its **local mirror**:

- a story keeps its stable `ST-NNN` id and carries `external: { provider, key, url }`
- pull before reviewing or implementing, push after creating, changing or approving a story
- a story must be linked before it reaches `ready`
- the tracker wins on conflict; the local copy is backed up, never silently lost
- reviews and `OPEN_QUESTIONS.md` stay local; `BACKLOG.md` is generated from the mirror

Sync with `/backlog-sync`; the rules are in `.claude/skills/backlog/SKILL.md`.

Start with `/bootstrap` (greenfield) or `/adopt` (brownfield), then `/feature` for new work.
