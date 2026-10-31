# Greenfield: starting a new project

```bash
npx kataster init --greenfield
# in the harness
/bootstrap
```

The order is fixed: **vision → domain → architecture → UX → stories**. Technology comes after the domain, never
before it.

For an idea that is larger than one project – several services, a new product line – `/shape` can frame it first.
Without a domain model it will stop at `unknown` placement and send you back here; that is the correct answer, not
a failure.

## Phase 1 – Vision

The frontier is every `[OPEN]` in `docs/product/vision.md`: problem, user groups, goals, non-goals, success criteria,
constraints, the domain in one paragraph. Grilled in rounds, each question with a recommended answer.

Two rules that do the most work:

- **No technology in this phase.** If the user starts with a framework, park it: that is an ADR after the domain,
  and the domain may change the answer.
- **Force a non-goal.** A vision without a "we will not do this" is a wish list.

## Phase 2 – Event storming

Big-picture storming, phases 1–6 of the `event-storming` skill:

1. 8–15 suspected events, in the user's words, past tense
2. Timeline into flows, pivotal events marked
3. Hotspots, grilled where the user can decide now
4. Commands and actors
5. Policies, including time-triggered ones
6. Read models

`docs/domain/events.yaml` is written after every phase and validated by a hook.

## Phase 3 – Domain model and architecture

`domain-architect` proposes bounded contexts, the context map, aggregates with testable invariants, and the
logical data model. Then, in this order:

1. **Shape** – the simplest architecture that meets the documented requirements. A monolith is the default;
   anything distributed cites a requirement.
2. **Tech stack** – one ADR, `status: proposed`, driving requirements cited. Only the user sets `accepted`.
3. **Other decisions** – only the ones that pass the architect's three criteria.

## Phase 4 – UX yardstick

Devices and design size, UI language(s), the states every screen needs (empty, full, rejected, no permission), and
the recurring patterns worth a guideline number. Written as rules into `docs/product/ux-guidelines.md`, with date
and reason.

## Phase 5 – Foundation stories and the first slice

Two kinds of work, kept apart:

- **Foundation tech tasks** – repository skeleton, one quality command (`verify`), CI, test harness, auth/roles if
  the vision needs them, deployment. Minimal, with `depends_on`, just in time.
- **The first vertical slice** – the smallest set of stories that delivers one real end-to-end path from the
  vision, each with Gherkin scenarios.

At most 10 scenarios per story; no implementation plan inside a domain story; every story links its `events`.

## Phase 6 – Review

`/review-stories` – one lead-dev pass over value, buildability and UX. The user approves every `ready`. With a tracker,
pull before the review and push the approved stories afterwards (`/backlog-sync`).

## Phase 7 – Build

```bash
node .claude/skills/implement/scripts/verify.ts   # should be green
/implement                                        # first foundation story
```

Then `/feature <idea | ticket>` for everything after that, `/groom-backlog` once the first bounded context is complete.

## Checkpoints

After vision, after storming, after the model, after the stories – summarize in 3–5 lines and ask whether to
continue. A bootstrap that runs to the end without a checkpoint produces a beautiful model nobody agreed to.
