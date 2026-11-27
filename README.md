# Kataster

**An agent workflow for domain-driven discovery and delivery.** Drop it into a repository, and the agent builds the
domain with you – by grilling, not by guessing – then carries it through stories, test-first implementation and
review.

The name is the German word for the official register of land parcels and their boundaries – a map that is
maintained, not invented. The domain model is that register: bounded contexts are the parcels, the glossary and the
data model are the entries, and nothing goes in without evidence.

Works in two situations:

- **Brownfield** – the repository already has code. `/adopt` analyses code, docs, tests, schema and git history,
  drafts the domain model with evidence, and grills you to correct it. No rewrite, no invented domain.
- **Greenfield** – nothing but an idea. `/bootstrap` grills the vision, runs an event storming, builds contexts,
  aggregates, the data model and the ADRs, and derives the foundation stories and first vertical slice.

The same workflow then handles every large idea (`/shape`), every feature (`/feature`), every story review
(`/review-stories`), implementation (`/implement`) and backlog care (`/groom-backlog`, `/retro`).

```bash
npx kataster init
```

That is the whole installation. It writes `.claude/`, `.opencode/`, `AGENTS.md` and a `docs/` skeleton into the
current repository, detects the stack, and asks four questions – the last one is whether stories stay local or live
in GitHub Issues or Jira (and if so, for the project or repository).

---

## Why this exists

Agents are good at writing code and bad at knowing what the words mean. A repository without a domain model produces
code that is locally plausible and globally inconsistent: three names for one concept, rules enforced only in the UI,
features nobody can place. Kataster makes the domain a first-class artifact – glossary, events, contexts,
aggregates, invariants – and makes the agent earn every statement in it from the user or from evidence.

Two rules run through everything:

1. **Facts are the agent's job, decisions are the user's.** The agent looks things up; it never invents a domain
   term, a rule or a boundary.
2. **The user confirms, the agent writes.** Grilling works in rounds on the *frontier*: every question whose
   prerequisites are settled, each with a recommended answer. Nothing is assumed silently.

## Requirements

- Node.js **22.18+** (the tooling runs TypeScript directly, no build step)
- Git
- An agent harness: **OpenCode** or **Claude Code**
- Optional: `gh` for pull requests and a GitHub Issues backlog, the `mcp-atlassian` MCP server for a Jira backlog,
  a preview provider (Vercel, Netlify, …) for acceptance testing

## Quick start

```bash
# existing repository
npx kataster init --brownfield
# new project
npx kataster init --greenfield
# stories in GitHub Issues or Jira
npx kataster init --backlog github --github-repo acme/shop
npx kataster init --backlog jira --jira-project PROJ
```

Then open the repository in your agent harness and run `/adopt` or `/bootstrap`.

Non-interactive (CI, scripts):

```bash
npx kataster init . --yes --name "Acme" --ui-language de --artifacts en
```

## What gets installed

```
.claude/
  project.json          project profile – name, stack, languages, commands, backlog backend (edit this)
  skills/               the workflow skills (grilling, event-storming, domain-model, architect, backlog, …)
  skills/adopt/scripts/ repository map and per-package docs for brownfield adoption
  skills/feature/scripts/ read-only intake: story, GitHub/Jira ticket or URL → route
  skills/research/      research workflow, template and the deterministic research check
  skills/metrics/       phase markers and the cost/time report per story (story-metrics.ts)
  agents/               review agents, the read-only researcher and the on-demand UX utility (Claude Code)
  hooks/                plain-Node guardrails and validators
  lib/                  deterministic domain/story/backlog logic
.opencode/
  commands/             the slash commands
  agents/               the same agents for OpenCode
  plugins/kataster/ adapter that runs the .claude hooks in OpenCode
AGENTS.md               short entry point for every session (merged, never clobbered)
CLAUDE.md               imports AGENTS.md for Claude Code (created, or the import added to an existing file)
CONTEXT.md              the glossary – starts as a template
docs/
  workflow.md           the map: sources of truth, commands, phases, rules
  product/vision.md     the vision, grilled with you
  product/initiatives/  proposals for large ideas from /shape (no stories)
  product/ux-guidelines.md   the interface yardstick
  prototypes/           throwaway prototypes on their own branch; the default branch keeps the README
  research/             evidence for cross-cutting questions, with an expiry (format in its README)
  domain/events.yaml    the event storming model (empty is valid)
  domain/context-map.md          target context map
  domain/context-map.as-is.md    as-is snapshot – created by /adopt
  domain/gap-register.md         as-is ↔ target gaps – created by /adopt
  architecture/data-model.md
  architecture/repo-map.*      generated by /adopt: packages, roles, edges, adoption ranking, concept slices
  engineering/conventions.md   how this repo builds code + the seam catalog
  stories/              the backlog – or the local mirror of GitHub/Jira
  stories/metrics/      append-only token and time entries per story and feature
  adr/                  architecture decisions
  reviews/              story reviews and adoption reports
```

Existing `AGENTS.md`, `.claude/settings.json` and `.opencode/opencode.jsonc` are **merged**, not overwritten
(`opencode.jsonc` in place: its comments and formatting stay).
Existing `CONTEXT.md` and `docs/` are never touched.

## The commands

| Command | What it does |
|---|---|
| `/adopt [scope] [--stories]` | Brownfield: repository map → one concept or package slice (+ shared library) → evidence → grilling → context docs and checks → gap register; scope is a package path, `--paths`, `--route`, `--table`, `--event`, `--cluster` or a term; stories only with `--stories`; repeat per slice |
| `/bootstrap` | Greenfield: vision → event storming → domain model → architecture → UX → foundation stories |
| `/grill-me` | Relentless interview on a plan, decision or idea |
| `/grill-with-docs` | The same, writing glossary and ADRs as you go |
| `/event-storming [process]` | Big-picture or single-process event storming |
| `/feature <idea \| ST-NNN \| #123 \| PROJ-123>` | New feature from an idea, an existing story or a ticket: intake and routing, grilling, focused storming, model, stories, review; bugs become a regression story; `--prototype` adds a throwaway prototype before the stories; `--research` forces the research step |
| `/shape <idea \| ticket> [--dry-run]` | Before a large feature: frame, place (existing/new context, shared library), research external facts, impact, slices, rough cost range, recommendation; creates no stories |
| `/research <question>` | One cross-cutting question as evidence: check existing research and expiry, dispatch the read-only researcher, persist findings in `docs/research/<topic>.md`, cite them in grilling and stories |
| `/review-stories [ST-…]` | Spec linter gate → `ready-for-human-review`; the user approves `ready` |
| `/backlog-sync [status\|pull\|push]` | Keep `docs/stories/` in sync with GitHub Issues or Jira |
| `/groom-backlog [scope]` | Periodic challenge: is this backlog still worth building? |
| `/implement [ST-NNN] [--fast]` | One story on its branch: domain = test-first, diff-scaled review, acceptance; `chore`/`task` or `--fast` = fast lane without Gherkin matching or formal reviews; `--prototype` settles an open UI question first; `--worker ST-NNN --base <branch>` is the worker mode an orchestrator starts |
| `/marathon [resume]` | **Experimental.** Unattended run: the main session orchestrates story after story – claim, `story-worker`, reviews, merge into `marathon/<date>`, verify – and ends with one pull request; `--max-stories`, `--max-failures`, `--no-gate-foundation`, `--budget-tokens`, `--budget-usd` |
| `/improve-codebase-architecture` | Scan for deepening opportunities, present them, grill one |
| `/retro` | Retrospective on a session, proposing rule changes |

### Spec-driven stories, fast lane

Stories are written by the main session as a **spec engineer**, not by simulated roles. Three lenses at once –
domain, architecture, testability – and one mechanical rule: **one story = one command + its events on one
aggregate**, at most four Gherkin scenarios. `aggregate` and `command` are required frontmatter and are cross-checked
against `docs/domain/events.yaml`.

Aggregates carry a status: `target` (the default when the field is missing), `as-is` (the factual boundary
recovered from code, with evidence) or `unresolved` (the boundary is unclear). A story on an `unresolved`
aggregate cannot leave `review`; `/adopt` writes `as-is` or `unresolved`, never an invented target. Every `as-is`
aggregate gets a row in `docs/domain/gap-register.md`, linking the as-is and target context maps.

The **spec linter** is the gate and costs no LLM tokens:

```bash
kataster lint-story                      # all stories
kataster lint-story ST-012               # one story
node .claude/skills/user-stories/scripts/lint-story.ts docs/stories/ST-012-*.md
```

Frontmatter and required fields, aggregate/command/event references, Gherkin `Given/When/Then`, the scenario limit
and unique titles. Green → `ready-for-human-review`; only you approve `ready`. The same rules run in the PostToolUse
hook and in `verify.ts`.

Non-domain work takes the **fast lane**: `type: chore` (UI tweak, refactor, dependency) or `type: task` (setup).
`/implement` detects it (or takes `--fast`) and does branch → implement → lint/typecheck/unit tests → PR, without
Gherkin matching or formal review agents. `type: tech-task` keeps its checklist and acceptance; `type: spike` is a
timeboxed question.

In a brownfield domain story, `/implement` first runs `characterize.ts`: it names the affected source files and
the tests it can find. An affected path with no test for the behaviour that is about to change gets a
**characterization test** that pins the current behaviour, committed separately before the story's red → green
loop. If the current behaviour contradicts the story, that is a finding and the story goes back to `review`; the
code is never silently adjusted. The fast lane skips this except for an explicit refactoring.

### Research as evidence

Cross-cutting stories rest on current primary sources. `/feature` triggers research through the grilling rules for
auth/identity, security, payment, privacy, accessibility, performance and new technologies; `--research` forces it
for a topic the trigger list does not catch. `/research <question>` runs the same path directly.

The **`researcher` is strictly read-only** – web search/fetch and repository reading, no write, no shell – and the
only way web content enters the session. Findings are data: instructions inside a fetched page, issue or comment are
ignored. The main session writes them verbatim to `docs/research/<topic>.md`; `expires` is computed at write and
refresh time from `research.expiryMonths` (default 12 months).

Research is **evidence, not a specification**. Only a finding you confirm in grilling becomes a testable criterion
with an observable threshold; rejected options are recorded with the reason. A story cites its evidence in
`sources: [...]`, and a story with `risk: high` or a configured gate label (`security`, `auth`, `payment`, `privacy`
by default) needs a resolvable source before `ready-for-human-review` – the linter warns, `story-status.ts` blocks.
Expiry is advisory: `research-check.ts --referenced` runs in `verify.ts` and warns about stale files without failing
the gate.

```bash
/research "Which PKCE configuration is required for a public SPA client?"
/feature "checkout with saved cards" --research
node .claude/skills/research/scripts/research-check.ts --referenced
```

### Starting from a ticket

`/feature` also accepts a reference: `/feature #123` (GitHub), `/feature PROJ-123` (Jira, with the issue fetched
through MCP), `/feature https://…` or `/feature ST-042`. A read-only intake resolves it and returns a route: an
existing `draft`/`review` story is revised, a `ready`/`in-progress` one goes to `/implement`, a finished one becomes a
new story, and a bug becomes one regression story instead of a feature. The ticket is **evidence, not a
specification** – its acceptance criteria are grilled, contradictions with the model are findings, and the source is
recorded in each story. `external` is still written only by the backlog sync.

### Shaping a large idea

`/shape` is the step between an idea and `/feature`. It grills the problem, decides where the work belongs – an
existing bounded context, a new one, or a shared library – maps what changes vs. what is built new, proposes 2–5
slices, and gives a rough **cost range with confidence and basis**. It ends with one recommendation: go, go with
slice 1, spike first, needs discovery, park or no-go. It creates **no stories**; each slice goes to `/feature`.

```bash
/shape "shop products with variants and channel prices"
/shape PROJ-123
/shape --dry-run "a new service next to the existing one"   # test the method, write nothing
```

The brief lands in `docs/product/initiatives/<slug>.md` (`proposed` until you accept it). A new service in an
existing monorepo is treated as a new context in an existing landscape, not as a greenfield project; a similar
service is used as evidence and as the cost anchor, never as a template.

### Prototyping an open question

When a UI, flow or state question cannot be settled on paper, `/feature --prototype` (or a proposal from the UX
lens during grilling) runs a throwaway prototype before the stories are written. The `ux-designer` builds one
self-contained HTML file under `docs/prototypes/<slug>/` – several structurally different UI variants or a
clickable state model. The verdict goes into the story and, when it is a recurring rule, into the UX guidelines;
the prototype is captured on a throwaway branch and never merged. `/implement --prototype` does the same for an
open UI question during engineering; if the prototype changes the story, the story goes back to `review`.

```bash
/feature "checkout with saved cards" --prototype=ui
/feature PROJ-123 --prototype=logic
/implement ST-042 --prototype
```

## Greenfield, end to end

1. `npx kataster init --greenfield` → review `.claude/project.json`.
2. `/bootstrap` → vision grilled, event storming, contexts/aggregates/data model, tech-stack ADR, UX guidelines.
3. `/review-stories` → the spec linter turns finished stories into `ready-for-human-review`; you approve `ready`.
4. `/implement` → one story at a time, test-first, reviewed, merged by you.
5. `/feature <idea>` for everything after that.

## Brownfield, end to end

1. `npx kataster init --brownfield` → the profile is filled from the detected stack and monorepo tooling
   (`repo.tooling`: Nx, Turborepo, Bazel, workspaces, Go, Cargo, Gradle, Maven).
2. `/adopt` → a deterministic **repository map** (`docs/architecture/repo-map.md`, `.json`) with packages,
   dependency edges, consumers, an adoption ranking, **layer packages** and **concept-slice suggestions**. No
   questions, no hand-scanning. In a layered repository (`api/`, `services/`, `repositories/`) a concept slice —
   not a package — is the unit.
3. `/adopt [scope]` → **one concept or domain plus at most one shared library**. The scope can be a package path,
   a glob set (`--paths`), an entry point (`--route`, `--table`, `--event`), a suggested cluster (`--cluster`) or
   a term; `slice.ts` resolves the candidate files across all layers. Two or three `repo-analyst` subagents return
   evidence (five lenses for a small single-package repository); the main session drafts `CONTEXT.md`,
   `events.yaml`, the as-is context map, as-is data model, conventions and de-facto ADRs. A real domain package
   gets `<package>/AGENTS.md` + `<package>/CLAUDE.md`; a cross-cutting concept slice gets
   `.claude/rules/<context>.md` with `paths:` frontmatter. Then it grills you.
4. The safety net turns confirmed rules into checks (types, lint/boundary, tests, hooks) – report-only with a
   baseline first, so a brownfield repository does not start red.
5. The gap analysis records **contradictions, missing behaviour and dead code** in the adoption report and the
   **gap register** (`docs/domain/gap-register.md`): one row per `as-is`/`unresolved` aggregate, linking the
   as-is boundary to the target model. It creates **no stories by default** – what already works is documented,
   not re-storied. `/adopt <scope> --stories` turns the selected gaps into a backlog when you want one.
6. `/adopt <next path>` for the next slice; `/adopt <scope> --stories`, `/review-stories`, then `/implement`.

Adopt in slices: one bounded context completely beats the whole repository shallowly. The root `AGENTS.md` stays
free of domain; the package docs are loaded only when someone works in that package.

## Monorepos

The installer detects the build tool (Nx, Turborepo, Bazel, pnpm/npm/yarn workspaces, Go, Cargo, Gradle, Maven)
and stores it in `.claude/project.json` → `repo.tooling`. `/adopt` builds the repository map once, then adopts
**one concept or domain plus at most one shared library per session**. Every adopted domain package gets an
`AGENTS.md` with its purpose, entities or public API, interfaces and pitfalls – plus a one-line `CLAUDE.md` so
Claude Code loads it on demand; OpenCode loads the nested `AGENTS.md` itself. A cross-cutting concept slice gets
`.claude/rules/<context>.md` with `paths:` instead, loaded by both harnesses when a matching file is touched. The
root `AGENTS.md` stays short and free of domain.

Commands use the detected tool instead of assuming a single package: `nx affected -t test`,
`turbo run test --filter=<package>`, `bazel test //<package>/...`, `pnpm --filter <package> test`. The map also
stores the tool's own graph – Turborepo via `turbo run <task> --dry=json`, Nx via `nx graph`, Bazel from the
`BUILD` deps – and `affected.ts` turns changed files into the affected packages plus the native filter command,
following shared-library dependents:

```bash
node .claude/skills/implement/scripts/affected.ts --changed libs/shared-kernel/src/index.ts
node .claude/skills/implement/scripts/affected.ts --base origin/main
```

## The project profile

`.claude/project.json` is the single place for project facts. Skills, hooks and scripts read it instead of assuming
`main`, `npm` or a language.

```jsonc
{
  "name": "Acme",
  "kind": "brownfield",
  "languages": { "artifacts": "en", "ui": "de" },
  "stack": { "summary": "TypeScript, Next.js, PostgreSQL" },
  "repo": {
    "defaultBranch": "main",
    "codeRoots": ["apps", "libs"],
    "tooling": {
      "kind": "nx",
      "config": "nx.json",
      "workspaces": ["apps/*", "libs/*"],
      "manager": "pnpm",
      "monorepo": true
    }
  },
  "commands": { "lint": "npm run lint", "typecheck": "npm run typecheck", "test": "npm test" },
  "review": { "preview": "vercel", "pullRequest": "gh" },
  "backlog": {
    "provider": "local",
    "github": { "repo": "", "labelPrefix": "kataster" },
    "jira": {
      "mcpServer": "mcp-atlassian",
      "project": "PROJ",
      "issueType": "Story",
      "statusMap": { "draft": "To Do", "ready": "Ready", "done": "Done" },
      "priorityMap": { "must": "Highest", "should": "High" }
    }
  },
  "research": {
    "expiryMonths": 12,
    "gate": { "risk": ["high"], "labels": ["security", "auth", "payment", "privacy"] }
  },
  "stories": { "sentencePattern": "\\bEn tant que\\b.+?\\bje veux\\b.+?\\bafin de\\b" } // optional
}
```

`verify.ts` runs exactly these commands. `/adopt` fills them from the code; edit them if the detection is wrong.

`languages.artifacts` also sets the story sentence the linter expects. English (`As a <role>, I want <goal>, so that
<benefit>`) is always accepted; `de` adds `Als <Rolle> möchte ich <Ziel>, damit <Nutzen>`. For another language, add
your own regular expression as `"stories": { "sentencePattern": "…" }` (a string or a list, matched
case-insensitively). Section headings, Gherkin keywords, IDs and status values stay English.

## Backlog backends

Stories live in one of three places, chosen at install with `--backlog` and stored in `.claude/project.json`:

| Provider | Source of truth | Transport |
|---|---|---|
| `local` (default) | `docs/stories/` | the Markdown files |
| `github` | GitHub Issues | `gh` CLI – deterministic, works from scripts |
| `jira` | Jira | `mcp-atlassian` – MCP is agent-only |

With a tracker, **the tracker leads** and `docs/stories/` is a synchronized local mirror. That keeps the deterministic
parts – validation, `BACKLOG.md`, scenario ↔ test traceability, `next-story` – working offline, while the team works in
the tracker.

- Each story keeps its stable `ST-NNN` id; the tracker key lives in `external: { provider, key, url }`. Test titles do
  not change.
- Only the backlog core syncs: story content, status, priority, size, risk, context, type, dependencies and labels.
  Reviews and `OPEN_QUESTIONS.md` stay local.
- A story must be linked before it reaches `ready` – the validator refuses an unlinked mirror story.
- On a conflict the tracker wins; the local file is backed up to `.kataster/backup/backlog/` first. GitHub's `push`
  refuses a story whose remote side changed; the Jira plan cannot see Jira, so pull before planning a push.
- GitHub issues are closed for `done`/`superseded`; Jira uses the configured status names and transitions.

```bash
node .claude/skills/backlog/scripts/backlog-status.ts   # what is linked, what drifted
node .claude/skills/backlog/scripts/backlog-push.ts     # mirror → tracker (GitHub)
node .claude/skills/backlog/scripts/backlog-pull.ts     # tracker → mirror (GitHub)
```

For Jira, `jira-plan.ts` prints the exact MCP calls, `jira-record.ts` writes the returned keys back, and
`backlog-pull.ts --from issues.json` imports what the agent fetched through MCP. The `backlog` skill has the full flow.

## Quality gates

- **Hooks** validate `docs/domain/events.yaml` and stories after every write, format and lint changed code, block
  edits to generated files and accepted ADRs, and stop force pushes, production deploys and destructive database
  commands.
- **Path-scoped rules** live in `.claude/rules/*.md` with `paths:` frontmatter – for patterns a directory cannot
  express. Claude Code loads them natively; in OpenCode the plugin attaches the matching rule to the session as
  soon as a file under its globs is read or written, so one file serves both harnesses.
- **Architecture boundaries** are data: `docs/architecture/boundaries.yaml` lists allowed/forbidden edges (first
  match wins), `boundary-check.ts` enforces them, and `boundaries.baseline.json` freezes existing debt so only
  new violations fail. `docs/engineering/checks.yaml` decides what runs at edit time and at Stop/CI; the
  `project-check.ts` dispatcher is wired once, not per package.

  ```bash
  node .claude/skills/adopt/scripts/boundary-check.ts --init
  node .claude/skills/adopt/scripts/boundary-check.ts            # fail on new violations
  node .claude/skills/adopt/scripts/boundary-check.ts --update-baseline
  ```
- **`verify.ts`** is the one gate: project checks, artifact validity, scenario ↔ test traceability, domain IDs in
  the code, glossary language. Referenced research files are checked for expiry as an advisory step.
- **Review agents** never write code or stories: `code-reviewer` and `acceptance-tester` report findings, the
  acceptance verdict decides whether a domain story is `done`, and a finding is fixed in the story or handed back
  as an open question. `ux-designer` is an on-demand utility (`ui: true`), never a gate.
- **Worker mode** (`/implement --worker ST-NNN --base <branch>`, agent `story-worker`): an orchestrator hands one
  story to a worker, which builds it on the story branch up to a green `verify.ts` and returns a JSON report
  instead of asking – `ready-for-review`, `blocked` or `returned-to-review`, with the branch, commits, changed files
  and verify result read from git by `worker.ts report`. An open domain or technical decision is `blocked`, never
  code. The worker picks no story, pulls nothing, starts no reviewer and writes neither `CONTEXT.md` nor ADRs; the
  orchestrator reviews and sends findings back to the same branch. The cut is identical in Claude Code and OpenCode
  and enforced by the agent (no subagent tool, no questions).

## Marathon runs (experimental)

> **Experimental.**
> - **Serial only:** one worker at a time (`--n` 1).
> - **The merge-blocker rules have not been through a real run yet** – only the test suite has exercised them.
> - **An unattended run needs narrowly scoped permissions** –
>   see [Permissions for an unattended run](#permissions-for-an-unattended-run) before you leave one alone.

`/marathon` turns the main session into the **orchestrator** of an unattended run. It builds nothing itself: story
after story it takes the next planned story, hands it to a `story-worker`, reads the worker's report, runs the
reviews, merges the story branch into the run's integration branch and verifies there. You get one pull request at
the end – and you merge.

```
/marathon                                   # 6 stories, 3 failures in a row, foundation gate on
/marathon --max-stories 10 --budget-usd 40  # more stories, with a cost budget from the story metrics
/marathon resume                            # go on with a run that was cut off – also from the other harness
```

- **Serial.** One claim, one worker at a time; `marathon-plan.ts` still refuses `--n` > 1 until conflict keys exist.
- **Setup.** `marathon-state.ts start-run` cuts `marathon/<date>` from the default branch and writes the run's state:
  the limits (stories per run, failures in a row), the foundation gate and an optional token or cost budget.
- **Per story.** Plan and claim → `story-worker` with `/implement --worker ST-NNN --base marathon/<date>` → the
  report decides: `blocked` and `returned-to-review` are escalated with their reason and the run goes on;
  `ready-for-review` starts the reviewers in the lanes of `/implement`. Every finding goes back to the worker in
  one fix pass – minors too, and reviewer questions the orchestrator decided with their conservative default – the
  same agent session where the harness can continue one, otherwise a fresh worker on the same branch. A pass for
  minors and decided questions alone is not reviewed again. A second `not accepted` escalates the story. A run
  creates no follow-up stories: only real product or domain questions are left for you. Then: merge into the integration branch, `verify.ts` there, `done`, new
  glossary terms and `proposed` ADRs from the report (the orchestrator alone gives out ADR numbers), `BACKLOG.md`,
  metrics.
- **It stops** when nothing is left to plan, a limit or the budget is reached, the foundation tasks
  (`type: tech-task`) are merged and a different story is next, or `verify.ts` is red on the integration branch –
  then immediately, and nothing is repaired.
- **The end.** The integration branch is pushed and a pull request to the default branch is opened (a draft after a
  red verify) with the summary, every escalation with its reason, the open questions that need you, the possible
  merge blockers, the decisions taken with a default (one line each) and the metrics of the run's stories. Escalated stories keep their local story branch.
- **One writer.** `.claude/state/marathon.json` changes only through `marathon-state.ts` (`start-run`, `claim`,
  `review`, `result`, `escalate`, `release`, `resume`, `finish`; `status` and `summary` read): every write is locked
  and atomic, a stale lock is broken with a warning, a broken state file is an error and is never overwritten, and a
  hook blocks hand edits. `result … merged` is checked against git and the last verify run.
- **Resumable.** A claim without a running worker is orphaned. When its pass already handed in a report (kept in
  `.claude/state/marathon-reports/`), the resumed orchestrator reads it instead of starting another pass; otherwise a
  worker continues on the story branch – counted as a pass after a cut-off, never as a failure – or the claim is
  released when there is no branch. The state is a plain file at the same path for both harnesses, so a run started
  in Claude Code can be resumed in OpenCode and the other way round.
- **One session at a time.** Sessions outlive their terminal – OpenCode keeps running them in its background service.
  `start-run` and `resume` make the calling session the orchestrator, `worker.ts start` the calling worker the holder
  of its story (`.claude/state/marathon-lease.json`); the hooks pass the caller to the scripts. A replaced
  orchestrator or worker is refused by the scripts and blocked on every tool call by `marathon-guard.ts` (both
  harnesses) while the run runs, so two workers never build on one checkout. Scheduling work for later (cron,
  OpenCode automations) is blocked during a run as well.
- **Decided with a default.** A worker settles a technical detail the story and the conventions leave open (an error
  status for a body that is not JSON, the time zone of "today") with the conservative default and lists it in its
  report; it does not block on it. The pull request lists these decisions for the user to confirm. A domain gap – a
  value a scenario's outcome depends on that nobody named – still ends the pass `blocked`.
- **Reviews and map before the merge.** `result … merged` refuses a `domain`, `tech-task` or `spike` story without
  an accepting `acceptance-tester`, and a stale repository map: the orchestrator runs `repo-map.ts` after every merge.
- **Workers per harness.** Claude Code: `Agent` tool with `subagent_type: story-worker`, continued with `SendMessage`.
  OpenCode: `subagent` tool with `agent: story-worker`; the call returns a `sessionID` and the report arrives as a
  background result; the same tool with that `sessionID` continues the worker.

### Permissions for an unattended run

An unattended run waits at every permission prompt, and nobody is there to judge one. Allow what the run needs, and
nothing more. The workflow scripts are allowed in both harnesses already; the rest is yours to add:

| Allow | Deny |
|---|---|
| `git add`, `git commit`, `git merge`, `git switch`, listing branches | `git push` to the default branch, with `--force`, `--delete` or `--mirror` |
| `git push origin marathon/*` and `git push -u origin marathon/*` – no other push | `git reset --hard`, `git clean`, `git branch -d/-D`, `git switch --force` |
| `gh pr create` | `rm -r`, `rm -rf` |
| your test, lint, type-check and verify commands, each by name | installing packages (`npm install`, `npx -y`) |
| editing files inside the project | asking the user (nobody is there) |

In Claude Code these are `Bash(…)` entries in `permissions.allow` and `permissions.deny` of
`.claude/settings.json`, plus `Edit(/**)` and `Write(/**)` to allow and `AskUserQuestion` to deny; run it with `--permission-mode dontAsk`, which refuses what is not allowed instead of
waiting. It applies `allow` rules only once the folder is trusted. In OpenCode they are `shell` rules in
`.opencode/opencode.jsonc`, plus a `question` deny: put a `shell *` deny first, your allow rules after it and the denies last – the last
matching rule wins. A later upgrade never puts a rule where it would override yours: a rule a new version adds lands in front
of your `shell *` deny and does nothing until you move it behind it – `npx kataster doctor` names it. Your global
OpenCode config (`~/.config/opencode`) is not considered by the installer, and OpenCode applies the project's rules
after it. Do not use a blanket auto mode (`--auto`, bypassing permissions) for an unattended run. A `*` in
a rule matches any text, spaces included, so keep the denies even with narrow allows. Rules like these and the
Kataster hooks are guard rails, not a sandbox: whatever your allowed commands run (a package script, a test) runs
with your rights, so use a repository and credentials you can afford to have touched.

In Claude Code's `dontAsk` mode a command with a heredoc is refused, so the skills pass JSON to the scripts as files
under `.kataster/details/`. In OpenCode, `.opencode/opencode.jsonc` ships `"automations": false`: an automation runs
later, outside the session's permissions – in a test run an agent used `automation.create` to get around its shell
rules. Set it to `true` if the project wants automations; an upgrade keeps the value. During a run the guard blocks
creating one either way.

## Story metrics

`/shape`, `/feature`, `/review-stories` and `/implement` mark their phases, and the hooks collect tokens and time
per story – in Claude Code and OpenCode alike, for the main session and every subagent:

```bash
node .claude/skills/metrics/scripts/story-metrics.ts report                  # stories, features, size vs. actual
node .claude/skills/metrics/scripts/story-metrics.ts report --story ST-012   # phases of one story
node .claude/skills/metrics/scripts/story-metrics.ts report --feature order-photos --since 2026-11-01
```

- **Stored** (append-only, committed): `docs/stories/metrics/ST-NNN.json` and `feature-<slug>.json` – one entry per
  phase pass, stream and model with raw tokens (input, output incl. reasoning, cache read, cache write), `harness`,
  `model`, agent time and user wait time. Tokens outside every phase go to an `unassigned` pot.
- **Derived** by the report: cost from `metrics.prices` in `.claude/project.json` (USD per million tokens per model;
  no built-in prices – an unpriced model shows `–` and a warning), and the feature's spec cost split across its
  stories by scenarios or checklist items.
- **Sources:** the Claude Code transcripts (including `subagents/`) and the OpenCode database (read-only, child
  sessions included). Markers and wait events live in `.claude/state/metrics/` and are not committed.

Details: [`.claude/skills/metrics/SKILL.md`](.claude/skills/metrics/SKILL.md).

## Upgrading

```bash
npx kataster upgrade
npx kataster doctor
```

`upgrade` replaces workflow files, keeps project content (`CONTEXT.md`, `docs/`, `project.json`) and refuses to
overwrite files you changed locally – it lists them instead. `--force` overwrites and writes a backup to
`.kataster/backup/`. A file you deleted stays deleted – a docs skeleton `README.md` you do not want, or
`.claude/package-lock.json` in a pnpm repository; `upgrade --restore` brings such files back, and `doctor` fails if
another workflow file still uses one.

**An upgrade never loosens your permissions.** Your `deny` rules always win, and your `ask` rules yield only to
Kataster's own scripts. In OpenCode, where the last matching rule wins, a Kataster rule that would override one of
yours is added in front of it, or left out when yours stands in another config file; the upgrade lists these and
`doctor` says what does not work because of them. A `.claude/settings.json` that is not plain JSON is left untouched –
fix it and run the upgrade again.

Project content includes `docs/workflow.md` and the context maps. An upgrade does not rewrite them; compare
`docs/workflow.md` with `templates/docs/workflow.md` if you want the new rules in an existing project. The schema
changes are additive: an aggregate without `status` is `target`, a missing `context-map.as-is.md` or gap register is
not an error, and the new checks are advisory until the artifacts exist.

## Design notes

- **`.claude/` is the source of truth.** OpenCode and Claude Code share skills, agents and hooks; `.opencode/` is an
  adapter, not a second workflow.
- **Plain Node, no build step.** Hooks and validators run on Node 22.18+ with one runtime dependency (`yaml`).
- **Generated files stay generated.** `BACKLOG.md` and `event-storming.md` are rendered; edit the sources.
- **The backlog is local by default.** One Markdown file per story; no issue tracker required. GitHub Issues and Jira
  are opt-in, and `docs/stories/` stays the mirror that validation and traceability run on.

## Name

The name is a historical reference, not a domain: the workflow has none of its own. Everything project-specific
was removed when the package was extracted – the examples are neutral, the stack is detected, and the language is
yours.

## Contributing

The toolkit is maintained in the open: bug reports, a skill that fills a real gap and sharper prompts are welcome.
[CONTRIBUTING.md](CONTRIBUTING.md) has the setup, the payload rules and the release process;
[SECURITY.md](SECURITY.md) is the way to report a vulnerability privately. Participation is covered by the
[Code of Conduct](CODE_OF_CONDUCT.md).

## Credits

Kataster stands on other people's work:

- **Matt Pocock** – [skills](https://github.com/mattpocock/skills), [aihero.dev](https://www.aihero.dev). The grilling
  interview (`grilling`, `grill-me`, `grill-with-docs`), test-driven development (`tdd`), the deep-module vocabulary
  (`codebase-design`), the architecture survey (`improve-codebase-architecture`), the throwaway prototype
  (`prototype`), the research skill (adapted: read-only researcher, source tiers, expiry, grilling integration), the
  retro, the domain-modeling discipline and `writing-for-agents` come from his skill repository – partly adapted,
  partly copied verbatim under MIT. The per-file mapping and the license text are in
  [.claude/THIRD_PARTY_NOTICES.md](.claude/THIRD_PARTY_NOTICES.md).
- **John Ousterhout**, *A Philosophy of Software Design* – "Design It Twice" and the depth, seam and deletion-test
  vocabulary.
- **Eric Evans**, *Domain-Driven Design* – ubiquitous language, bounded contexts, aggregates.
- **Martin Fowler** – the smell baseline the review agents work from.

## License

MIT
