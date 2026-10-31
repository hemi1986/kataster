# La Guardia

## Context
La Guardia is software for the pinball museum to manage its pinball machines: repairs, defects, manuals and a ticket system for reporting problems. The name is a joke: Fiorello La Guardia was the New York mayor who banned pinball in 1942.

## Phases: Discovery and Engineering
- **Discovery** produces the domain artifacts in `docs/` – including the backlog of user stories as Markdown files. It continues for new features (`/feature`).
- **Engineering** implements the `ready` stories one by one with `/implement`. The application is a Next.js monolith at the repository root (`docs/adr/0001-tech-stack.md`), set up by the foundation stories ST-001, ST-059 and ST-003. Code and discovery artifacts live in this one repository and change together.

## Sources of Truth
| Artifact | File | Owner |
|---|---|---|
| Vision, user groups, scope | `docs/product/vision.md` | user + product-owner |
| UI/UX decisions (yardstick) | `docs/product/ux-guidelines.md` | ux-designer (user approves) |
| Glossary (ubiquitous language) | `CONTEXT.md` | domain-model skill (event storming, `/feature`, domain-architect, `/implement`) |
| Event storming model | `docs/domain/events.yaml` | event storming / domain-architect |
| Visualization (generated!) | `docs/domain/event-storming.md` | hook – never edit manually |
| Context map | `docs/domain/context-map.md` | domain-architect |
| Logical data model | `docs/architecture/data-model.md` | domain-architect |
| Architecture decisions (ADRs) | `docs/adr/` | architect skill / domain-architect (user accepts) |
| Stories | `docs/stories/ST-NNN-*.md` | requirements-engineer; status `in-progress`/`done` by `/implement` |
| Backlog (generated!) | `docs/stories/BACKLOG.md` | hook – never edit manually |
| Open questions | `docs/stories/OPEN_QUESTIONS.md` | everyone |
| Reviews | `docs/reviews/` | review-stories; per story `ST-NNN-acceptance.md` (acceptance-tester) and, in the normal review lane, `ST-NNN-code-review.md` (code-reviewer) |
| Engineering conventions, seam catalog | `.claude/skills/engineering-conventions/SKILL.md` | written after ST-003, user approves |
| Operations routines (updates, later environments, recovery) | `docs/operations/` | `/implement` (ST-061–ST-063) |
| Application code and tests | repository root (`src/`, …) | `/implement` |

## Skills
| Skill | Covers |
|---|---|
| `grilling` (`/grill-me`) | relentless interview in rounds with recommended answers – how we ask questions |
| `domain-model` | language in `CONTEXT.md`, bounded contexts, aggregates, logical data model |
| `architect` | architectural decisions, ADRs, tech stack |
| `/grill-with-docs` | grilling + domain-model + architect: interview that writes glossary and ADRs as it goes |
| `/event-storming`, `/feature` | discovery entry points (see workflow); both start by grilling |
| `user-stories`, `/review-stories` | story format, validation, review |
| `ux-design` | how we decide the interface: the UX frontier to grill, what a story says about a screen, review order |
| `/groom-backlog` | periodic challenge of the open backlog: still worth building, dependencies, priorities |
| `/implement` | engineering entry point: one story test-first, verify, review, refactor, acceptance by the acceptance tester |
| `tdd` | red → green loop, good tests, seams |
| `codebase-design` | vocabulary for deep modules: module, interface, depth, seam, adapter, leverage, locality |
| `/improve-codebase-architecture` | periodic scan for deepening opportunities, then grilling on the chosen one |
| `/retro` | retrospective on a session: candidates to improve the agent's environment, the user picks |
| `writing-for-agents` | how to write skills, agent files and `CLAUDE.md` |

## Rules
- **Everything in English**: artifacts, stories, Gherkin, glossary, code, comments. IDs are CamelCase with a prefix (`EVT-DefectReported`, `CMD-ReportDefect`). Only the UI texts are German (and English on visitor pages), from the message catalogs.
- Domain terms exactly as in `CONTEXT.md`, never an `_Avoid_` synonym – in docs and in code. New term → add it to `CONTEXT.md` first.
- **Don't guess.** Capture anything unclear as a hotspot (`HS-n` in `events.yaml`) or `[OPEN]` + an entry in `OPEN_QUESTIONS.md`. During implementation an unclear or wrong story goes back to `review` – never decide it in the code.
- `events.yaml` and stories are validated by a hook after every write, including story status changes. Fix hook errors immediately, never work around them.
- Decide the tech stack only after event storming and domain model, via ADR. New ADRs are `proposed`; only the user sets `accepted`. Accepted ADRs are never edited, only superseded (a hook enforces it).
- The backlog is local by default: stories are Markdown files in `docs/stories/`. With `backlog.provider` = `github` or `jira`, that directory is the local mirror and the tracker is the source of truth.
- **Traceability in the code**: every Gherkin scenario has a test titled exactly `ST-NNN: <scenario title>`; commands, events, read models and policies carry their ID from `events.yaml`. `verify.ts` checks both.
- Story status changes go through `node .claude/skills/implement/scripts/story-status.ts`. A `done` story is never reopened – changes become a new story.
- Never weaken or delete a test to get green. One branch and one pull request per story; the user merges.
- Tooling in `.claude/` (hooks, validators, scripts) is TypeScript run directly by Node ≥ 22.18 (type stripping) – no Python, no build step. Erasable TypeScript syntax only. The application has its own build (Next.js).
- Subagents don't know this conversation: when delegating, always pass file paths and a clear task.
- At most 3 questions to the user at once – **except in grilling rounds**, which ask the whole frontier, each question with a recommended answer.

## Tool Access
`gh` and the Vercel MCP server (`vercel` in `.mcp.json`) are optional – the `session-start` hook reports what is missing, `README.md` says how to set it up.
- With `gh` (scope `repo`) `/implement` opens the pull request itself; without it, push and hand the user the compare URL from `git push`.
- With Vercel MCP you look up the branch's preview deployment, its state and its build/runtime logs; without it, ask the user for the preview URL.
- Never work around a missing access silently (no token in a file, no login in the background) – report it and let the user decide.

## Workflow
Initial discovery:
1. `/event-storming` – grills the vision, then big picture; afterwards `/event-storming <process>` for detailed flows
2. `@domain-architect` – contexts, aggregates, data model, glossary, ADR proposals (incl. tech stack)
3. `@requirements-engineer` – derive stories from events/commands
4. `/review-stories` – one lead-dev pass (value, build, UX), user approves → `status: ready`
5. Hand-off: `docs/stories/BACKLOG.md` lists all `ready` stories in implementation order for the engineering workflow

Later features and changes: `/feature <idea>` – grills the idea, runs a focused event storming, updates domain model/ADRs, derives stories (label `feature:<slug>`) and runs the story review on them – the user approves in that review.

Engineering, story by story: `/implement [ST-NNN]` (empty = next ready story whose dependencies are done):
1. Prepare – branch, `in-progress`, context pack from the discovery artifacts
2. Test plan – scenario → seam → test; the user is asked only for a seam outside the catalog
3. Red → green per scenario (`tdd`)
4. `verify.ts` – lint, module boundaries, types, tests, traceability; the full browser run once before the push, CI repeats it on the pull request
5. Review, scaled to the risk of the diff – **light lane** (size S, no events/commands/migrations/form input/new dependency): `@acceptance-tester` only; **normal lane**: `@code-reviewer` and `@acceptance-tester` in parallel, `/code-review` for L/XL or shared platform code, `/security-review` when the diff touches input handling, login/roles/session, uploads/files or security headers
6. Refactor – fix findings in the story, the recommended option without asking; a follow-up story only past the follow-up hurdle (security/data-loss risk or blocks a named story, and can't be fixed in about an hour, and no existing story can take it)
7. Acceptance tester's verdict → `done`, pull request – **the user only merges** (asked again only when something goes badly wrong); the next story starts in a fresh session

After the foundation stories, per finished bounded context or about every 8–10 **domain** stories: `/improve-codebase-architecture` for the code and `/groom-backlog` for what is still planned – not in between. Progress is measured in done domain stories and scenarios (`docs/stories/BACKLOG.md`), not in the total number of stories. Technical groundwork is pulled in just in time: into the first story that needs it.

Anytime: `/grill-me` to stress-test a plan, `/grill-with-docs` to do the same while recording glossary terms and ADRs.

## Next.js
@AGENTS.md
