---
name: feature
description: Entry point for a new feature or change once the initial discovery is done – accepts a free-text idea, an existing story (`ST-NNN`) or a ticket (`#123`, `PROJ-123`, URL), grills the idea, runs a focused event storming, updates domain model and ADRs, derives stories into the backlog (local, or the tracker mirror) and runs the story review; bug tickets go to a regression story instead.
disable-model-invocation: true
argument-hint: "<idea | ST-NNN | #issue | PROJ-123 | URL>"
---

# New Feature

The argument is a feature idea, an existing story or a ticket. Empty → ask the user for it first.
Pick a short kebab-case slug for it (e.g. `order-photos`); stories get the label `feature:<slug>`.

## 0. Intake – when the argument is a reference

A reference is `ST-NNN`, `#123`, `PROJ-123`, a GitHub/Jira URL, or a Jira issue passed with `--from <issue.json>`.
Resolve it before asking anything:

```bash
node .claude/skills/feature/scripts/intake.ts <reference> --json
# Jira: fetch the issue with jira_get_issue, write it as JSON, then
node .claude/skills/feature/scripts/intake.ts PROJ-123 --from <issue.json> --json
```

The script is read-only. It returns the source, a matching local story (by id or `external`), signals and a `route`.
Follow the route:

| `route` | What to do |
|---|---|
| `continue-story` | Read that story and treat it as the idea. Its open questions are the first grilling frontier. Do not create a parallel feature. |
| `review-story` | Stop; run `/review-stories <id>` (or revise the story if it is still being written). |
| `implement-story` | Stop; the next command is `/implement <id>`. |
| `new-story` | Finished behaviour is final; continue as a new feature and name the old story as the predecessor. |
| `bug` | Use the bug path below, not the feature pipeline. |
| `feature` | Continue with step 1. |

Before grilling, summarize the source in 3–5 lines and ask the user to confirm it – problem, requested behaviour,
acceptance hints, contradictions. A ticket is **evidence, not a specification**: grill its acceptance criteria,
separate solution language from the problem, and record contradictions with `CONTEXT.md`, `events.yaml`, ADRs or the
UX guidelines. Record the source in every derived story as `Source: <ref> (<url>)` under `## Context`. Never write
`external` by hand – the backlog sync owns it.

### Bug path

A bug is behaviour that contradicts what the model already documents. Check `CONTEXT.md`, `events.yaml`, accepted
ADRs and `docs/product/ux-guidelines.md` first.

- **Documented behaviour, code deviates** → one story, `type: story`, label `bug`, with a regression scenario that
  reproduces the report and at least one edge case. No new events or commands; link the affected event if one
  exists. Then `/review-stories` and `/implement` as usual.
- **The documented rule itself is wrong** → this is a feature: the rule changes, so run the normal pipeline and say
  so in the wrap-up.
- **No model yet** (brownfield not adopted) → do not invent one from the bug; record the finding and point to
  `/adopt`.

Do not run an event storming for a bug and do not create a feature slug unless the rule changes.

## 1. Preparation
Read `docs/product/vision.md`, `CONTEXT.md`, `docs/domain/events.yaml`, `docs/domain/context-map.md`, `docs/architecture/data-model.md`, `docs/adr/`, `docs/stories/BACKLOG.md`. Find out what already exists for this idea (events, stories, hotspots) before asking anything. With an intake result, use its source and matching story instead of searching from scratch. If a linked story exists, pull the tracker first (`/backlog-sync pull`) so the mirror is current.

## 2. Grill the idea
Call the `skill` tool four times, for `grilling`, `domain-model`, `architect` and `ux-design` (the first three are the set of `/grill-with-docs`, which can't be called from a skill). Grill the user until the frontier is empty and they confirm a shared understanding. The grilling carries the three perspectives the story review later only checks – product owner, lead dev, UX. With an intake result, the ticket's claims and the intake's `signals` seed the frontier; unresolved comments and contradictions are the first questions. Typical branches:
- **PO**: Which problem, for which user group, and what value? Measurable outcome? Does it fit the vision, or touch a non-goal? If it changes scope → update `docs/product/vision.md` with the user. Must vs. could – what ships first?
- **Lead dev**: Which existing code, data and stories change? Is there a migration? What is hard to test? Where does it cut into stories – each a vertical slice of at most ~10 scenarios?
- Which existing processes, events and stories does it change? What's explicitly out of scope?
- **UX – does a person see anything?** Almost always yes – then the UX frontier of `ux-design` belongs in the rounds: entry point, the screen's one job, what is shown before acting, what happens afterwards, the rejected, empty, full and no-permission cases, and the UI wording. A feature whose screens nobody named gets them by accident. Stories with a frontend part get the label `ui`.
- New or changed terms → `CONTEXT.md` inline.
- An architectural trade-off → ADR (`status: proposed`) only if the architect skill's three criteria hold.

Don't move on before the user confirms.

## 3. Focused event storming
Read `.claude/skills/event-storming/SKILL.md` and follow it with the feature as focus: phases 1–6 (phase 0 is covered by step 2), 7–8 only if aggregates or contexts are affected. Capture the feature as its own flow (`FLOW-<FeatureName>`) and write `docs/domain/events.yaml` after every phase.

## 4. Domain model & architecture
- Contexts, aggregates or the data model affected → delegate to `domain-architect` with the file paths, the changed/new IDs from `events.yaml` and a clear task.
- An architectural trade-off came up that wasn't recorded during grilling → offer an ADR per the architect skill's three criteria (`status: proposed`, the user accepts).
- A UX decision changes or adds a guideline → delegate to `ux-designer`: write exactly these decisions into `docs/product/ux-guidelines.md`. The audit of existing screens belongs to `/groom-backlog`, not to the feature.

## 5. Stories
Delegate to `requirements-engineer`: derive stories for the feature's new or changed commands, policies and read models; name the event/command IDs, the label `feature:<slug>`, the label `ui` for every story with a frontend part, the label `bug` for the bug path, the source reference (`Source: <ref> (<url>)`) for every story derived from a ticket, the UX decisions from step 2 (with the G-numbers of the guidelines they reference), the story cut from step 2, and existing stories that need revising. Finished stories get `status: review`; have it report the IDs of all stories it created or revised.

## 6. Review
Read `.claude/skills/review-stories/SKILL.md` and follow it with the story IDs from step 5 as the arguments (only this feature's stories, not everything in `review`). The user still approves every change and every `ready`.

## 7. Wrap-up
Summarize: the source and the route taken (idea, ticket, existing story or bug), glossary changes, new/changed events, ADRs proposed, stories created and their review outcome (`ready` vs. still open), open hotspots/questions. Point to `docs/stories/BACKLOG.md`, where `ready` stories are queued for the engineering workflow. For a bug, say which documented rule was restored, or that the rule changed and became a feature.
