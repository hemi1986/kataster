---
name: bootstrap
description: Greenfield entry point – grills the vision, runs a big-picture event storming, builds the domain model and architecture with ADRs, sets the UX yardstick and derives the foundation stories and first vertical slice. Use when starting a new project.
disable-model-invocation: true
argument-hint: "[project idea in one sentence – empty = ask first]"
---

# Bootstrap a New Project

You are starting from nothing but an idea. The order is fixed: **vision → domain → architecture → UX → stories**.
Technology comes after the domain, never before it.

Idea: the arguments from the invocation (empty → ask the user for one sentence first).

## Preconditions

1. Read `.claude/project.json`. If it is missing, tell the user to run `npx kataster init` first and stop.
2. If the repository already has code, this is the wrong command: use `/adopt`.
3. Call the `skill` tool for `grilling` and `domain-model`. Grilling sets how you ask; domain-model sets how the
   glossary is written.

## Phase 1 – Grill the vision

The frontier is every `[OPEN]` in `docs/product/vision.md`: problem, user groups, goals, non-goals, success
criteria, constraints, the domain in one paragraph. Work it in rounds as the `grilling` skill says – numbered
questions, recommended answer each, whole frontier per round.

Rules for this phase:

- **No technology.** No framework, no database, no hosting. If the user starts there, park it: "that is an ADR
  after the domain, and the domain may change the answer."
- **Force a non-goal.** A vision without a "we will not do this" is a wish list.
- **Success criteria must be measurable**, or they are not criteria.
- **Write as you go**: remove answered `[OPEN]`s from `docs/product/vision.md`; resolved terms go into
  `CONTEXT.md` immediately (domain-model skill).

Stop when the frontier is empty and the user confirms a shared understanding.

## Phase 2 – Big-picture event storming

Read `.claude/skills/event-storming/SKILL.md` and follow it with the whole domain as focus. Phases 1–6 are
mandatory; 7–8 are the proposal you hand to the architect.

- 8–15 suspected events as a starting point, in the user's words, past tense.
- Order them into `flows` – one per business process. Mark pivotal events.
- Collect hotspots systematically; grill the ones the user can decide now.
- Commands and actors, policies (including time-triggered), read models.
- Write `docs/domain/events.yaml` after **every** phase. The hook validates and renders it; fix errors at once.

Stop when every event has an aggregate or context, every command a trigger, and no hotspot blocks a boundary.

## Phase 3 – Domain model and architecture

Delegate to `domain-architect` with the file paths and the IDs from `events.yaml`: bounded contexts, context map,
aggregates with testable invariants, and the logical data model. The agent proposes; the user decides.

Then the architecture, in this order:

1. **Shape** – the simplest architecture that meets the documented requirements. A monolith is the default;
   anything distributed needs a cited requirement.
2. **Tech stack** – only now, following `.claude/skills/architect/TECH-STACK.md`. One ADR
   (`docs/adr/0001-tech-stack.md`, `status: proposed`), with the driving requirements cited from
   `docs/product/vision.md` and `docs/domain/events.yaml`. **Only the user sets `accepted`.**
3. **Other decisions** – only the ones that pass the architect skill's three criteria. Not every library.

## Phase 4 – UX yardstick

Call the `skill` tool for `ux-design`. Grill the questions the vision does not settle:

- devices and the design size (the size the layout is built for, not the exception),
- UI language(s) and where terms come from,
- the states every screen needs (empty, full, rejected, no permission),
- the recurring patterns worth a G-number.

Delegate to `ux-designer`: write the approved decisions into `docs/product/ux-guidelines.md` as rules with date
and reason. Do not let it become a mood board.

## Phase 5 – Foundation stories and the first slice

Delegate to `requirements-engineer` in two parts:

1. **Foundation tech tasks** – what every later story relies on: repository skeleton, the single quality command
   (`verify`), CI, the test harness and test data approach, auth/roles if the vision needs them, deployment.
   Each is a tech task with a checklist and `depends_on`, not a domain story. Keep them minimal: foundation just
   in time, not a platform project.
2. **The first vertical slice** – the smallest set of stories that delivers one real end-to-end path from the
   vision (e.g. "report → triage → resolve"), each a story with Gherkin scenarios, `ui` where a person sees
   something.

Rules: at most 10 scenarios per story; no implementation plan inside a domain story; every story links its
`events`; `status: draft`, then `review` when finished.

## Phase 6 – Review

Read `.claude/skills/review-stories/SKILL.md` and follow it with the story IDs from Phase 5. The user approves
every `ready`. Fix what the review finds through `requirements-engineer` – never by editing a story into shape
yourself when the change is structural.

## Phase 7 – Wrap-up

Summarize: vision settled (and what stayed open), number of events/commands/policies/read models, contexts and
aggregates, ADRs proposed, UX guidelines written, stories created and their review outcome.

Then name the next step:

- `node .claude/skills/implement/scripts/verify.ts` should be green before the first `/implement`.
- `/implement` for the first foundation story; `/feature <idea>` once the domain has a language and the
  foundation stands.
- `/groom-backlog` after the first bounded context is complete.

## Rules

- **Domain before technology, always.** If a technology question blocks the domain, it is a spike with a timebox,
  not an architecture decision made in advance.
- **No invented requirements.** Every ADR cites a path in `docs/`. No documented requirement → no complexity.
- **The user owns the language and the decisions.** You propose; they confirm. Accepted ADRs are theirs to set.
- **Stop at checkpoints.** After vision, after event storming, after the model, after the stories – summarize in
  3–5 lines and ask whether to continue. A bootstrap that runs to the end without a checkpoint produces a
  beautiful model nobody agreed to.
