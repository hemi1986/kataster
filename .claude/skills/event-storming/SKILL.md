---
name: event-storming
description: Facilitates an interactive event storming with the user (big picture or a single process) and maintains docs/domain/events.yaml and the glossary in CONTEXT.md. Starts by grilling the user on the vision. For domain exploration and new business processes.
disable-model-invocation: true
argument-hint: "[process/focus, e.g. 'order fulfilment' – empty = big picture]"
---

# Facilitating Event Storming

You are the facilitator, the user is the domain expert. You propose, they decide.
Focus of this session: the arguments from the invocation (empty = big picture across the whole domain).

## Preparation
1. Call the `skill` tool for `grilling` and `domain-model`. Grilling sets how you ask questions; domain-model sets how you guard the language in `CONTEXT.md`.
2. Read `docs/product/vision.md`, `CONTEXT.md`, `docs/domain/events.yaml`, `docs/domain/context-map.md`.
3. Format reference: `templates/events.example.yaml` in this skill folder (unrelated example domain – copy the format only, no content).

## Facilitation Rules
- **Ask like the grilling skill**: numbered questions in rounds, each with your recommended answer; a round asks the whole frontier (everything answerable now). Facts you can look up are your job, decisions are the user's.
- **Events** are business facts in the past tense: "Order placed", not "Button clicked", and not CRUD ("Record saved").
- Uncertainties the user can't settle now, conflicts, "it depends" → capture immediately as a **hotspot** (`HS-n`), don't argue them away.
- **Language**: challenge terms against `CONTEXT.md`, sharpen fuzzy words, and add resolved terms to `CONTEXT.md` the moment they're settled (domain-model skill).
- No technology: no tables, endpoints, frameworks, screens.
- Write in the artifact language. IDs: CamelCase with prefix (`EVT-OrderPlaced`); names in plain words using the glossary terms ("Order placed").
- Write `docs/domain/events.yaml` after **every phase**. The hook validates it and renders `docs/domain/event-storming.md`. If it reports errors: fix them immediately. Warnings are normal in early phases.
- At the end of each phase: a 3–5 line summary + checkpoint ("Continue with phase X?").

## Phases
0. **Grill the vision** – Entry point. Grill the user on whatever the focus needs and `docs/product/vision.md` doesn't settle yet: problem, user groups, goals, non-goals, success criteria, constraints (big picture); trigger, participants, outcome and scope boundaries (single process). Continue until the frontier is empty and the user confirms a shared understanding, then update `vision.md` (remove answered `[OPEN]`s) and `CONTEXT.md`.
1. **Chaotic exploration** – Propose 8–15 suspected events as a starting point. The user deletes, corrects, adds. Ask specifically about exceptions, failure cases and rare events.
2. **Timeline** – Order events into `flows` (one flow per business process). Mark pivotal events (phase changes) with `pivotal: true`.
3. **Hotspots** – Systematically collect gaps and contradictions along the timeline, then grill them: resolve the ones the user can decide now (`status: resolved` + `resolution`), keep the rest open.
4. **Commands & actors** – What triggers each event, and who does it? Capture external systems (`EXT-`). Business rules of the command go into `rules` – only what the command adds beyond the `invariants` of its aggregate, which are stated once, there (user, 2026-10-01).
5. **Policies** – "Whenever <event>, then <command>". Include time-triggered ones (event with `origin: time`) and manual routines.
6. **Read models** – What information does an actor need to trigger the command? (`fed_by`, `used_by`, `fields`)
7. **Aggregates (proposal)** – Which rules must be protected consistently? Rough assignment of commands/events. Detailed work is done by `domain-architect`.
8. **Bounded contexts (proposal)** – Where do language or responsibility change? Propose rough boundaries.

When focusing on a single process: phases 0–6 for that process (phase 0 only for what the vision doesn't cover yet), 7–8 only if something new emerges.

## Wrap-up
- Output: number of events/commands/policies/read models, open hotspots, glossary terms added or changed.
- Run `node .claude/skills/event-storming/scripts/validate-events.ts` and show the result.
- Propose the next step: `@domain-architect` for context map, aggregates, data model and ADRs.
