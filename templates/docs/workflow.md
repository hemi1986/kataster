# Workflow – {{project}}

The map of this repository's agent workflow. `AGENTS.md` is the short version loaded into every session; this file
is what to read when you are unsure where something belongs.

## Two phases

- **Discovery** produces the domain artifacts in `docs/` – including the backlog of stories as Markdown files. It
  continues for every new feature (`/feature`).
- **Engineering** implements the `ready` stories one by one with `/implement`. Code and discovery artifacts live in
  the same repository and change together.

## Sources of truth

| Artifact | File | Owner |
|---|---|---|
| Vision, user groups, scope | `docs/product/vision.md` | user + `product-owner` |
| Initiative briefs (proposals, no stories) | `docs/product/initiatives/<slug>.md` | `/shape`; user accepts |
| UI/UX decisions (yardstick) | `docs/product/ux-guidelines.md` | `ux-designer` (user approves) |
| Glossary (ubiquitous language) | `CONTEXT.md` | `domain-model` skill |
| Event storming model | `docs/domain/events.yaml` | event storming / `domain-architect` |
| Visualization (generated!) | `docs/domain/event-storming.md` | hook – never edit manually |
| Context map | `docs/domain/context-map.md` | `domain-architect` |
| Logical data model | `docs/architecture/data-model.md` | `domain-architect` |
| Repository map (generated!) | `docs/architecture/repo-map.json`, `docs/architecture/repo-map.md` | `repo-map.ts` – never edit manually |
| Package docs (loaded on demand) | `<package>/AGENTS.md` + `<package>/CLAUDE.md` | `/adopt`, user confirms the prose |
| Path-scoped rules | `.claude/rules/*.md` (both harnesses) | `/adopt`, user approves |
| Architecture boundaries | `docs/architecture/boundaries.yaml` | user confirms; checked by `boundary-check.ts` |
| Existing boundary debt (generated) | `docs/architecture/boundaries.baseline.json` | `boundary-check.ts --update-baseline` |
| Project checks (what runs when) | `docs/engineering/checks.yaml` | `/adopt`, user approves |
| Architecture decisions (ADRs) | `docs/adr/` | `architect` skill / `domain-architect` (user accepts) |
| Stories | `docs/stories/ST-NNN-*.md` | `requirements-engineer`; status by `/implement`; with a tracker this is the mirror |
| Backlog backend | `.claude/project.json` → `backlog.provider` – `local`, `github` or `jira` | user |
| Backlog mirror (with a tracker) | `docs/stories/` | `/backlog-sync` |
| Backlog (generated!) | `docs/stories/BACKLOG.md` | hook – never edit manually |
| Open questions | `docs/stories/OPEN_QUESTIONS.md` | everyone |
| Reviews | `docs/reviews/` | `review-stories`, `acceptance-tester`, `code-reviewer` |
| Engineering conventions, seam catalog | `docs/engineering/conventions.md` | written after the foundation, user approves |
| Application code and tests | `repo.codeRoots` in `.claude/project.json` | `/implement` |

## Commands

| Command | Covers |
|---|---|
| `/bootstrap` | greenfield: vision → event storming → model → architecture → UX → stories |
| `/adopt [scope] [--stories]` | brownfield: repo map → one slice (domain + shared library) → evidence → domain draft → package docs → grilling → gap register; stories only with `--stories`; repeat per slice |
| `/shape <idea \| ticket>` | before a large feature: frame, place (existing/new context, shared library), impact, slices, rough cost range, recommendation; creates no stories; `--dry-run` writes nothing |
| `boundary-check.ts` | architecture boundaries: `--init`, `--update-baseline`, `--changed`, `--json` |
| `affected.ts` | monorepo fast loop: changed files or `--base` → affected packages + native test command |
| `grilling` (`/grill-me`) | relentless interview in rounds with recommended answers – how we ask questions |
| `/grill-with-docs` | grilling + `domain-model` + `architect`: writes glossary and ADRs as it goes |
| `/event-storming [process]`, `/feature <idea \| ST-NNN \| ticket>` | discovery entry points; both start by grilling. `/feature` resolves a story or ticket read-only and routes bugs to a regression story |
| `user-stories`, `/review-stories` | story format, validation, review |
| `backlog`, `/backlog-sync` | local / GitHub Issues / Jira mirror, sync and conflict rules |
| `ux-design` | how we decide the interface: the UX frontier, what a story says about a screen, review order |
| `/groom-backlog` | periodic challenge of the open backlog |
| `/implement [ST-NNN]` | one story test-first, verify, review, refactor, acceptance, pull request |
| `tdd` | red → green loop, good tests, seams |
| `codebase-design` | vocabulary for deep modules |
| `/improve-codebase-architecture` | periodic scan for deepening opportunities, then grilling |
| `/retro` | retrospective on a session; the user picks the changes |
| `writing-for-agents` | how to write skills, agent files and `AGENTS.md` |

## Rules

- **Language.** Artifacts and code are in the artifact language (`languages.artifacts`), UI texts in the UI language
  (`languages.ui`) – both in `.claude/project.json`. IDs are CamelCase with a prefix (`EVT-OrderPlaced`).
- **Domain terms exactly as in `CONTEXT.md`**, never an `_Avoid_` synonym – in docs and in code. A new term goes into
  `CONTEXT.md` first.
- **Don't guess.** Capture anything unclear as a hotspot (`HS-n` in `events.yaml`) or `[OPEN]` plus a row in
  `OPEN_QUESTIONS.md`. During implementation, a wrong or unclear story goes back to `review` – never decided in code.
- **`events.yaml` and stories are validated by a hook after every write**, including status changes. Fix errors
  immediately; never work around them.
- **Tech stack only after event storming and domain model**, via ADR. New ADRs are `proposed`; only the user sets
  `accepted`. Accepted ADRs are never edited, only superseded (a hook enforces it).
- **The backlog is local by default.** `docs/stories/` is the backlog and no issue tracker is required. With
  `backlog.provider` = `jira` or `github` in `.claude/project.json`, the tracker is the source of truth and
  `docs/stories/` is its local mirror; sync through `/backlog-sync` and never edit `BACKLOG.md` by hand. Reviews and
  open questions stay local. `ST-NNN` stays the stable id; the tracker key lives in `external`.
- **Traceability in the code**: every Gherkin scenario has a test titled exactly `ST-NNN: <scenario title>`;
  commands, events, read models and policies carry their ID from `events.yaml`. `verify.ts` checks both.
- **Status changes** go through `node .claude/skills/implement/scripts/story-status.ts`. A `done` story is never
  reopened – changes become a new story.
- **Never weaken or delete a test to get green.** One branch and one pull request per story; the user merges.
- **Subagents don't know the conversation**: when delegating, pass file paths and a clear task.
- **Adopt in slices.** One domain plus at most one shared library per session; never the whole monorepo. The
  ranking in `docs/architecture/repo-map.md` suggests where to start.
- **The root `AGENTS.md` has no domain.** Structure, commands, hard conventions and links. Domain language lives
  in `CONTEXT.md`, package reality in `<package>/AGENTS.md` – loaded only when someone works there.
- **Directory docs before glob rules.** Rules that apply to a directory belong in its `AGENTS.md`; `.claude/rules/`
  with `paths:` is for patterns a directory cannot express. Claude Code scopes it natively, OpenCode's plugin
  attaches it when a matching file is read or written – one file, both harnesses.
- **Checks are green on day one.** Brownfield checks start report-only with a baseline and only new violations
  fail; a red hook gets switched off. `docs/engineering/checks.yaml` decides what runs at edit time and at
  Stop/CI; the `project-check.ts` dispatcher is wired once and never per package.
- **Boundaries are data, not prose.** `docs/architecture/boundaries.yaml` lists the allowed/forbidden edges
  (first match wins); `boundary-check.ts` enforces them. Existing debt lives in
  `boundaries.baseline.json` and only shrinks.
- **A ticket is evidence, not a specification.** When `/feature` starts from an `ST-NNN`, `#issue` or Jira key, the
  source is recorded in the story (`Source: …`), its acceptance criteria are grilled like any other claim, and
  `external` is still written only by the backlog sync. A bug is a story with the label `bug`, not a separate type; a
  change to a documented rule is a feature, because the rule changes.
- **Initiatives are not a backlog.** `docs/product/initiatives/` holds proposals from `/shape`; they have no
  `ready`/`done` and create no stories. Only `docs/stories/` is work. Cost is a range with a basis and a
  confidence – never a single number, never a commitment.
- **At most 3 questions to the user at once** – except in grilling rounds, which ask the whole frontier.

## Workflow

Discovery, first time: `/bootstrap` (greenfield) or `/adopt` (existing code), then `/review-stories` until stories
are `ready`. A monorepo is adopted slice by slice: finish one domain plus its shared library, then run
`/adopt <next path>` – the map keeps track of what is adopted. Later features: `/feature <idea | ticket>`; an idea
larger than one feature goes through `/shape` first and then `/feature` per slice.

Engineering, story by story: `/implement [ST-NNN]` (empty = next ready story whose dependencies are done):
prepare → test plan → red/green per scenario → `verify.ts` → review lane scaled to risk → refactor → acceptance
tester's verdict → `done` + pull request; **the user only merges**. Start the next story in a fresh session.

With a tracker: pull before `/review-stories`, `/groom-backlog` and `/implement`; push after changing or approving
stories and after `done`. The tracker leads on conflict; `docs/stories/` is the mirror and `BACKLOG.md` stays
generated from it.

Periodic: `/improve-codebase-architecture` and `/groom-backlog` after a bounded context or about every 8–10 done
domain stories – not in between. Progress is measured in done domain stories and scenarios, not in story count.

## Tool access

- **`gh`** (optional): with it, `/implement` opens the pull request itself and a GitHub backlog syncs; without it, push
  and hand the user the compare URL. The session-start hook reports what is missing.
- **`mcp-atlassian`** (optional, for a Jira backlog): configured in the harness. Jira reads and writes go through the
  MCP tools; the local mirror keeps validation and traceability deterministic.
- **Preview provider** (optional, `review.preview` in `.claude/project.json`): with it, acceptance testing uses the
  branch preview; without it, the reviewers work from the code.
- Never work around missing access silently (no token in a file, no login in the background) – report it and let the
  user decide.
