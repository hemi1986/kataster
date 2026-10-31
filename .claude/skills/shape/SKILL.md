---
name: shape
description: Grill a large idea before it becomes features – frame the problem, decide where it belongs (existing or new bounded context, shared library), map what changes vs. what is new, slice it, and produce a rough cost range with confidence. Creates no stories; ends with a go / slice / spike / discover / park / no-go recommendation.
disable-model-invocation: true
argument-hint: "<idea | ST-NNN | #issue | PROJ-123 | URL> [--dry-run]"
---

# Shape a large idea

This is the step between an idea and `/feature`. It answers four questions and then stops:

1. **Should we do this at all?** Problem, outcome, fit with the vision, non-goals.
2. **Where does it belong?** Existing context, new context, shared library, or cross-cutting.
3. **What does it touch?** What changes, and what is genuinely new.
4. **What does it roughly cost?** Scope, range, risk, confidence – not a single number.

It creates **no stories**. Stories remain `/feature`'s job, one slice at a time.

## When to use it

Use `/shape` when the idea is larger than one feature: it crosses contexts, needs a new context or service, a
migration, an integration, or the question "should we, and what does it cost?" is still open. A normal story goes
straight to `/feature`; don't turn this into ceremony.

A **new service in an existing monorepo** is not greenfield. It inherits the stack, the shared packages, the
deployment and the identity model – treat those as constraints, not as a blank page.

## 0. Intake and mode

A reference (`ST-NNN`, `#123`, `PROJ-123`, URL) is resolved with the read-only intake:

```bash
node .claude/skills/feature/scripts/intake.ts <reference> --json
# Jira: fetch the issue with jira_get_issue, write it as JSON, then
node .claude/skills/feature/scripts/intake.ts PROJ-123 --from <issue.json> --json
```

Summarize the source in 3–5 lines and have the user confirm it. A ticket is **evidence, not a specification**.

`--dry-run` – or the user saying "just walk me through it" – means: grill, show the brief in the conversation,
write **nothing**. Without it, write the artifact only after the user confirms the summary.

## 1. Read and scan

Read `docs/product/vision.md`, `CONTEXT.md`, `docs/domain/events.yaml`, `docs/domain/context-map.md`,
`docs/architecture/data-model.md`, `docs/architecture/repo-map.md`/`.json`, `docs/engineering/conventions.md`,
`docs/adr/`, `docs/stories/BACKLOG.md`, `docs/product/ux-guidelines.md`.

Also scan the **configuration and integration points** for systems that already own the data the idea is about:
`.env.example`, `configuration.ts`, config DTOs, API clients, external ids in entities. A name that appears only
there – a store, an ERP, a marketplace – is evidence of a system the brief must place. Report what you found and
what it implies; do not turn a config key into an architectural decision.

If an analogue exists (a sibling service the idea resembles), use it as evidence. If it is large and not adopted,
delegate one `repo-analyst` lens with a clear task instead of reading all of it yourself. Its model is evidence,
**never** the new context's model.

Three starting points:

- **Domain model exists** (adopted, or after `/bootstrap`): full placement, impact and cost.
- **No domain model**: frame and slice are still useful; placement stays `unknown`; recommend `/bootstrap` or
  `/adopt`. Do not invent contexts from the idea.
- **Partially adopted / an analogue exists**: use the sibling's model where it exists and its code/config where it
  does not. Confidence is `medium` at best; say what is inferred. If the sibling is central, recommend
  `/adopt <sibling>` as the first slice before committing to a cost range.

## 2. Frame – product owner lens

Call the `grilling` skill. The frontier:

- Which problem, for which user group, and why now?
- What is the observable outcome, and how would we know it worked?
- Must / should / could / won't – what ships first, what is explicitly out?
- Does it fit `vision.md`, or does it change the vision? A vision change is the user's decision.
- What is the cost of **not** doing it – opportunity or fear?
- Constraints: deadline, regulation, budget, team, existing commitments.
- At least one non-goal: what this initiative will not become.

Don't move on before the user confirms a shared understanding.

## 3. Place – architect lens

Call the `architect` skill (and `domain-model` where the language is unclear). For each capability:

| If … | Then |
|---|---|
| same language, same invariants, additive change | **existing context** |
| a term means something else, or a new invariant must be immediately consistent | **new context** |
| different rate of change, team, regulation or external model | **new context** |
| pure logic used by two or more contexts, no lifecycle of its own | **shared library** |
| notifications, audit, auth, files – a generic capability | prefer an **existing generic context** over a new one |

A new **service** is not automatically a new **domain**, and a new domain is not automatically a new service.
Separate contexts can share infrastructure packages; they must not share a domain model just because the words
look alike. Same word, different meaning (Product as dish vs. Product as sellable variant) is the classic reason
to split.

Produce a recommendation **with at least one alternative and its consequence**, plus a confidence:

> Reuse `BC-Delivery` for rescheduling (cheap, but the aggregate grows) vs. a new `BC-Delivery-Planning` (cleaner
> consistency boundary, one more integration). Recommendation: existing context for slice 1, revisit if carriers
> get their own scheduling model.

The user decides.

## 4. Impact – lead-dev lens

Split the answer into **change** and **build new**. Leave nothing implicit.

| Dimension | Questions | Evidence |
|---|---|---|
| Domain | which aggregates, events, commands, policies, read models? new or changed? | `events.yaml` (IDs, counts) |
| Code | which packages and consumers? which new packages? | `repo-map`, dependency edges |
| Interfaces | screens/forms/flows, API endpoints, jobs, webhooks, integrations | `ux-guidelines`, conventions |
| Data | schema change, migration, backfill, retention, reporting | `data-model.md`, schema |
| Rules | boundaries (`boundaries.yaml`), permissions, checks (`checks.yaml`) | architecture checks |
| Tests | which seams – command, policy, read model, page? | seam catalog |
| Ops | config, deployment, monitoring, support | profile, ADRs |

## 5. Slice

Propose 2–5 independently valuable slices, walking skeleton first. Each slice should be a `/feature` run, not a
project. For each: outcome, contexts touched, dependencies, rough size, confidence.

If the idea cannot be sliced, say so – that is a finding, not a failure of the format.

## 6. Cost

Never one number. Give **scope**, **range** and **risk**, plus the basis.

- **Scope:** number of slices and stories, with sizes (XS–XL). The most defensible unit the toolkit has.
- **Range:** e.g. "3–5 stories, mostly S/M" or "2–4 weeks with one developer". Person-days only if the user has a
  calibration ("1 M ≈ 3 days"); otherwise keep story sizes.
- **Risk:** what could blow the estimate up – unknown integration, migration, compliance, missing language.
- **Confidence:** low/medium/high, and **what would raise it** (spike, prototype, measurement, talking to the
  carrier).
- **Basis:** the counts behind the estimate (e.g. 1 new command, 1 event, 1 policy, 1 read model, 1 page, 1
  migration, 2 packages, 1 integration).
- **Analogue:** if a similar service exists, use it as the calibration anchor – modules, LOC, endpoints, entities,
  specs, and which parts are domain-specific vs. generic. Say what can be reused and what is genuinely new. The
  analogue is evidence, not a template; a copy is not automatically the right design.

Rules: an unknown is a line in the brief, not a silent +20 %. A spike is a cost, not a gap – give it a question and
a timebox. Estimate the **delta** to today's system, not the whole system. Without evidence, say `unknown` and
recommend discovery.

## 7. Decide and write

End with exactly one recommendation:

`go` · `go with slice 1` · `spike first` · `needs discovery (/bootstrap or /adopt)` · `park` · `no-go`

The user decides. Write `docs/product/initiatives/<slug>.md` after the user confirms the summary of steps 2–6.
Set `status: proposed`; only the user sets `accepted`. On handoff, set `promoted: <slug>` and send the first slice
to `/feature`. **Do not create stories here and do not touch `docs/stories/`.**

With `--dry-run`, print the same brief in the conversation and write no file.

### Artifact

```markdown
---
status: proposed          # proposed | accepted | parked | rejected
created: 2026-10-31
source: PROJ-123          # optional
promoted: ""              # feature:<slug> once slices are handed to /feature
---

# Initiative: <title>

## Problem & outcome
## Fit with the vision
## Placement
| Capability | Context | New/existing | Why | Confidence |
## Impact – change vs. build new
| Dimension | Change | New | Evidence |
## Slices
1. …
## Rough cost
| Currency | Estimate | Confidence | Basis |
## Risks & open questions
## Recommendation
```

## Guardrails

- The brief is a proposal. The user sets `accepted`.
- Do not let the estimate become a commitment. It is a range with a basis.
- Every brief ends in a recommendation; do not use `/shape` to avoid a decision.
- Do not turn initiatives into a shadow backlog. They have no `ready`/`done`; only stories do.
- Do not write an artifact when the user only wants to test the method.
- Keep the artifact project-neutral except for the project's own terms from `CONTEXT.md`.
- Never present an analogue's domain model as the new context's model.
