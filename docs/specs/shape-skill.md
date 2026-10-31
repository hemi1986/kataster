# Spec: `/shape` – grill a large idea before it becomes features

Status: implemented · dry-run validated 2026-10-31

## Purpose

`/shape` is the step between an idea and `/feature`. It answers four questions and then stops:

1. **Should we do this at all?** Problem, outcome, fit with the vision, non-goals.
2. **Where does it belong?** Existing bounded context, new context, shared library, or cross-cutting.
3. **What does it touch?** Existing behaviour and code that changes, and what is genuinely new.
4. **What does it roughly cost?** Scope (slices/stories), a range, risk, confidence – not a single number.

The output is a short **initiative brief** plus a decision: go, go with slice 1, spike first, needs discovery,
park, or no-go. It creates **no stories**. Stories remain the only work items.

## Why this exists

The workflow currently jumps from "idea" to `/feature` (which decides to build and ends in stories) or to
`/bootstrap` (the whole project). There is no artifact for the question a product owner actually asks about a large
idea: *is this worth it, where does it land, and what does it drag in?* `/grill-me` asks good questions but produces
no artifact; `/groom-backlog` only challenges work that already exists.

`/shape` also makes the cost estimate honest, because the toolkit already holds the evidence: `repo-map` (packages,
consumers, churn), `events.yaml` (contexts, aggregates, commands, policies, read models), `conventions.md` (seams),
ADRs, and the story sizes in the backlog.

## Non-goals

- **No stories, no Gherkin, no task list.** Handoff is `/feature <slice>`.
- **No detailed event storming.** Count candidate commands/events/policies; do not model them.
- **No second backlog.** An initiative is a proposal, not a work item with a status competing with `docs/stories/`.
- **No invented domain.** Without a domain model, placement stays `unknown`; the recommendation is `/bootstrap` or
  `/adopt`.
- **No false precision.** No single number, no story-point theatre, no "100 % confident" estimate.

## Command

```
/shape <idea | ST-NNN | #issue | PROJ-123 | URL> [--dry-run]
```

- Free text → the idea.
- A reference → reuse the read-only intake from `/feature`
  (`node .claude/skills/feature/scripts/intake.ts <ref> --json`, Jira via `--from <issues.json>`). The ticket is
  evidence, not a specification.
- Empty → ask for the idea.
- `--dry-run` → run the grilling and show the brief in the conversation, write **nothing**. For testing the method,
  for a decision that is not ripe, or when the user explicitly says "nur mal durchspielen". Without it, the brief
  is written only after the user confirms the summary.

When `/shape` becomes the second consumer of the intake, promote the CLI to `.claude/lib/` and keep thin wrappers in
both skills. Until then, call the existing script.

## When to use it

Use `/shape` when at least one holds:

- the idea crosses more than one bounded context, or needs a new one;
- it is a **new service in an existing landscape** (the common case: a sibling of an existing service, with its own
  data, deployment and consumers);
- it needs a migration, a new external integration, or a new permission model;
- it is larger than roughly one feature / ten scenarios / one slice;
- the question "should we do this, and what does it cost?" is still open.

Do **not** use it for a normal story or a small feature. That is `/feature` directly. The ceremony must earn its
place.

## Inputs the skill reads

`docs/product/vision.md`, `CONTEXT.md`, `docs/domain/events.yaml`, `docs/domain/context-map.md`,
`docs/architecture/data-model.md`, `docs/architecture/repo-map.md`/`.json`, `docs/engineering/conventions.md`,
`docs/adr/`, `docs/stories/BACKLOG.md`, `docs/product/ux-guidelines.md`, and – if present – the source ticket.

Also scan the **configuration and integration points** for systems that already own the data the idea is about:
`.env.example`, `configuration.ts`, config DTOs, API clients, external IDs in entities. A name that appears only
there – a store, an ERP, a marketplace – is evidence of a system the brief must place, not a detail to ignore.
Say what you found and what it implies; do not let a config key become an architectural decision.

## Phases

### 0. Intake

Only with a reference: resolve it, summarize the source in 3–5 lines, confirm the summary. Note the source in the
brief (`source: …`). Never copy a ticket's solution language into the problem statement.

### 1. Frame – product owner lens

Use the `grilling` skill. The frontier is:

- Which problem, for which user group, and why now?
- What is the observable outcome, and how would we know it worked?
- Must / should / could / won't – what ships first, what is explicitly out?
- Does it fit `vision.md`, or does it change the vision? A vision change is the user's decision.
- What is the cost of **not** doing it? Is this an opportunity or a fear?
- Constraints: deadline, regulation, budget, team, existing commitments.
- Non-goals: at least one sentence that says what this initiative will not become.

### 2. Place – architect lens

Use the `architect` skill (and `domain-model` where language is unclear). For each capability in the idea:

| If … | Then |
|---|---|
| same language, same invariants, additive change | **existing context** |
| a term means something else, or a new invariant must be immediately consistent | **new context** |
| different rate of change, team, regulation or external model | **new context** |
| pure logic used by two or more contexts, no lifecycle of its own | **shared library** |
| notifications, audit, auth, files – a generic capability | prefer an **existing generic context** over a new one |

Produce a recommendation **with at least one alternative and its consequence**, e.g.:

> Reuse `BC-Delivery` for rescheduling (cheap, but the aggregate grows) vs. a new `BC-Delivery-Planning` (cleaner
> consistency boundary, one more integration). Recommendation: existing context for slice 1, revisit if carriers get
> their own scheduling model.

Confidence: `high` (model and code agree), `medium` (evidence, some unknowns), `low` (no model / no data).

### 3. Impact – lead-dev lens

Split the answer into **change** and **build new**. Leave nothing implicit.

| Dimension | Questions | Evidence |
|---|---|---|
| Domain | which aggregates, events, commands, policies, read models? new or changed? | `events.yaml` (IDs, counts) |
| Code | which packages and consumers? which new packages? | `repo-map`, `affected` edges |
| Interfaces | screens/forms/flows, API endpoints, jobs, webhooks, integrations | `ux-guidelines`, conventions |
| Data | schema change, migration, backfill, retention, reporting | `data-model.md`, schema |
| Rules | boundaries (`boundaries.yaml`), permissions, checks (`checks.yaml`) | architecture checks |
| Tests | which seams – command, policy, read model, page? | seam catalog |
| Ops | config, deployment, monitoring, support | profile, ADRs |

### 4. Slice

Propose 2–5 independently valuable slices, walking skeleton first. Each slice should be a `/feature` run, not a
project. For each: outcome, contexts touched, dependencies, rough size, confidence.

If the idea cannot be sliced, say so – that is a finding, not a failure of the format.

### 5. Cost – three currencies

Never one number. Give **scope**, **range** and **risk**, plus the basis.

- **Scope:** number of slices and stories, with sizes (XS–XL). This is the most defensible unit the toolkit has.
- **Range:** e.g. "3–5 stories, mostly S/M" or "2–4 weeks with one developer". Person-days only if the user has a
  calibration ("1 M ≈ 3 days"); otherwise keep story sizes.
- **Risk:** what could blow the estimate up – unknown integration, migration, compliance, missing language.
- **Confidence:** low/medium/high, and **what would raise it** (spike, prototype, measurement, talking to the
  carrier).
- **Basis:** the counts behind the estimate (e.g. 1 new command, 1 event, 1 policy, 1 read model, 1 page, 1
  migration, 2 packages, 1 integration). This makes the estimate reproducible and comparable later.
- **Analogue:** when a similar service already exists, use it as the calibration anchor – its modules, LOC, number
  of endpoints/entities/specs, and which parts are domain-specific vs. generic. Say which parts of the analogue
  the idea can reuse and which are genuinely new. The analogue is evidence, not a template: a copy of it is not
  automatically the right design.

Rules:

- An unknown is a line in the brief, not a silent +20 %.
- A spike is a cost, not a gap – give it a timebox and a question.
- Estimate the **delta** to today's system, not the whole system.
- If there is no evidence (empty repo, no domain model), say `unknown` and recommend discovery.

### 6. Decide and write

End with exactly one recommendation:

`go` · `go with slice 1` · `spike first` · `needs discovery (/bootstrap or /adopt)` · `park` · `no-go`

The user decides. The skill writes the brief after the user confirms the summary of phases 1–5.

## Artifact

`docs/product/initiatives/<slug>.md`:

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

No new ID scheme. The slug is kebab-case and becomes the label `feature:<slug>` when the first slice goes to
`/feature`. On handoff, set `status: accepted` and `promoted: <slug>`; do not create stories here.

With `--dry-run`, print the same brief in the conversation and write no file. Use it when the user is testing the
method or when the decision is still open; a dry run is not a rejected initiative.

## Three variants

- **With a domain model** (adopted brownfield, or after `/bootstrap`): full placement, impact and cost.
- **Without a domain model** (greenfield, or not yet adopted): frame and slice are still useful; placement is
  `unknown`; the recommendation is `/bootstrap` or `/adopt`. Do not invent contexts from the idea.
- **Partially adopted, or an analogous service exists** (the normal case in a mature monorepo): the idea's own
  service may not be adopted, but a sibling is – or is at least readable. Use the sibling as evidence: its
  domain model where it exists, its code and configuration where it does not. Mark placement `medium` at best and
  say which parts are inferred. If the sibling is central to the idea, recommend `/adopt <sibling>` as the first
  slice before committing to a cost range. Never present the sibling's model as the new context's model.

**New service vs. new project.** "Greenfield" above means an empty repository. A new service inside an existing
monorepo is not greenfield: it inherits the stack, the shared packages, the deployment and the identity model. Shape
it as a new context in the existing landscape, and treat the monorepo's conventions as constraints, not as a blank
page.

## Guardrails

- The brief is a proposal. The user sets `accepted`.
- Do not let the estimate become a commitment. It is a range with a basis.
- Do not use `/shape` to avoid a decision: every brief ends in a recommendation.
- Do not turn initiatives into a shadow backlog. They have no `ready`/`done`; only stories do.
- Do not write an artifact when the user only wants to test the method (`--dry-run`, or an explicit "nur
  durchspielen"). The conversation is the output then.
- Keep the payload project-neutral. No product names, no stack assumptions.
- Both harnesses: skill in `.claude/skills/shape/`, command in `.opencode/commands/shape.md`.

## Integration checklist

- [x] `.claude/skills/shape/SKILL.md`
- [x] `.opencode/commands/shape.md`
- [x] `templates/docs/product/initiatives/README.md` (skeleton, explains the artifact)
- [x] `templates/docs/workflow.md`: command table, sources table, one rule
- [x] `README.md`: command table + short section
- [x] `guide/concepts.md`, `guide/greenfield.md`, `guide/brownfield.md`
- [x] `test/install.test.mjs`: the new files are installed
- [x] `CHANGELOG.md`

## Test plan

1. **Worked example** (`docs/specs/shape-example.md`) walked through once with a neutral domain, checked against the
   artifact template.
2. **A real initiative** from the user, walked through before the skill is considered done. The format is only
   proven if the cost range survives the user's scrutiny. **Partially done 2026-10-31** – see the shopfi dry run
   below. The run stopped at the frontier by design; the answers and the final brief are still open.
3. **Negative cases:** an idea that is really one story (must recommend `/feature`), an idea in a repo without a
   domain model (must recommend `/adopt`/`/bootstrap`, placement `unknown`), a ticket that already covers a `ready`
   story (must not create a parallel initiative).
4. Install test: all new files are present after `init`.
5. **Dry run:** `--dry-run` produces the brief in the conversation and writes no file, no story and no sync state.

## Dry run: shopfi (2026-10-31)

A real idea in a real repository: a new shopping PIM service (`shopfi`) next to the existing gastro service
`mampfi` in the `digitalservices` monorepo. The run was explicitly a test, so it used no artifact and no
`/adopt`.

What it produced:

- facts from the repo (mampfi: 728 TS files, ~35.7k LOC, 19 API modules, 40 entities, 68 specs; shared `@repo/*`
  infrastructure; `mampfi` not yet adopted; `MackStore` visible only in config and external product ids);
- a placement recommendation with an alternative: separate context and `apps/shopfi`, no shared domain kernel,
  admin area in `dsadmin`, own Mongo/Cidaas/deployment;
- a cost range with a basis (analogue `mampfi`, generic PIM subset ~6k LOC, new variants/prices/channels, new
  admin area) and explicit low confidence;
- a frontier of eight decisions (PIM vs. commerce, MackStore, data ownership, consumers/tenant, MVP model, UI,
  why now, team).

What the run exposed, now folded into this spec:

- the two-variant model was too binary – a **partially adopted repo with an analogous service** is the normal case;
- the **analogue** is the best cost anchor and was missing from the cost model;
- a **new service in an existing monorepo** is not "greenfield";
- a test needs a **no-write mode** (`--dry-run`);
- **configuration/integration points** (`.env.example`, config DTOs, external ids) are evidence of existing systems
  that own the data, and must be scanned.

It also confirmed the guardrail: the run did **not** invent the answers to the frontier and did **not** create
stories. That is the correct end state for an unconfirmed initiative.

## Open questions

- Does the brief need a machine-readable status for `/feature` to read, or is the frontmatter enough?
- Should `docs/product/initiatives/` get an index, or is the file system enough?
- Is `promoted` the right field, or should the link live in the story labels only?
- Does `/shape` need a `--quick` mode (skip the impact table) for ideas that are clearly small? Default: no – use
  `/feature`.
- Is the config/integration scan mandatory when no analogue is adopted, or a "best effort" step? The shopfi run
  suggests mandatory: the name of the system that owns the data is not optional context.
- Should `--dry-run` also skip the frontier questions (a quick review of an idea), or always grill? Default: always
  grill; a brief without the decisions is a guess.
