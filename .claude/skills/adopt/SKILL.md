---
name: adopt
description: Brownfield entry point – maps the repository, adopts it in slices (one domain plus at most one shared library), drafts the domain model with evidence, grills the user, documents each package where it lives and records the gap; it derives stories only when asked (--stories). Use when the workflow is dropped into a repository that already has code.
disable-model-invocation: true
argument-hint: "[package path or concept scope (--paths/--route/--table/--event/--cluster/term) – empty = map the repository and choose a slice; add --stories to derive stories now]"
---

# Adopt an Existing Repository

The repository already works. Your job is to **recover the domain it encodes** – in slices, not by rewriting it
and not by documenting the whole monorepo in one pass. Code is evidence of decisions someone already made; the
user is the only one who can say which of the readings is the intended domain.

Scope: the arguments from the invocation (empty = map the repository and choose a slice). `--stories` is an
explicit opt-in for Phase 6; without it the adoption records the gap but creates no stories. Pick a short
kebab-case slug for the adoption (`adoption-<scope>`) for the report file.

## Preconditions

1. Read `.claude/project.json`. If it is missing, tell the user to run `npx kataster init` first and stop.
2. If the repository has no code yet, this is the wrong command: use `/bootstrap`.
3. Read what already exists, before analysing anything: `CONTEXT.md`, `docs/product/vision.md`,
   `docs/domain/events.yaml`, `docs/domain/context-map.md` (**target**), `docs/domain/context-map.as-is.md`
   (**as-is**), `docs/architecture/data-model.md`, `docs/architecture/repo-map.md`,
   `docs/engineering/conventions.md`, `docs/adr/`, `README*`, existing `docs/` and any `AGENTS.md`/`CLAUDE.md`.
   Existing documentation is **primary evidence** – it outranks your inference from code. The target map is
   read-only here: it says where the project wants to go, not what the code does. Contradictions between docs and
   code are findings, not something to resolve silently.

## Phase 0 – Repository map (deterministic, no questions)

Run:

```bash
node .claude/skills/adopt/scripts/repo-map.ts
```

It scans manifests, source files and git history and writes:

- `docs/architecture/repo-map.json` – packages, paths, kinds, roles, internal dependencies, consumers, adoption
  ranking, concept-slice suggestions, and the build tool's own graph when it answers (Turbo, Nx, Bazel)
- `docs/architecture/repo-map.md` – the same as a readable map (never edit it by hand)
- the generated repository block in `AGENTS.md` – tooling, layout, commands, adopted slices
- `.claude/project.json` → `repo.tooling` – Nx, Turborepo, Bazel, pnpm/npm/yarn workspaces, Go, Cargo, Gradle, Maven

Read the map yourself. **Do not hand-scan the repository for packages**; if the map is stale, run it again.
The map is facts, not domain: it says where code lives and what depends on what, never what a word means.

Pay attention to two readings the map adds for layered repositories:

- **Layer packages** – generic names such as `services`, `repositories` or `utils` that host many concepts. They
  are layers, not domains; do not adopt “the services package” as if it were one bounded context.
- **Concept slices** – clusters that share a file stem or a table across layers (`ordersController`,
  `orderService`, `orderRepository`, `orders` table). They are slice *suggestions*, not confirmed boundaries.

## Phase 1 – Choose the slice (one round, at most three questions)

The scope is either a package path, a **concept scope** or a mix. A concept scope can be:

- a glob set: `--paths "src/api/order*,src/services/order*,db/migrations/*order*"`
- an entry point: `--route "POST /orders"`, `--table orders`, `--event EVT-OrderPlaced`
- a suggestion from the map: `--cluster order`
- a free term: `--term order`

Resolve a non-package scope deterministically before asking:

```bash
node .claude/skills/adopt/scripts/slice.ts --cluster order
node .claude/skills/adopt/scripts/slice.ts --table orders
node .claude/skills/adopt/scripts/slice.ts --route "POST /orders"
```

The resolver follows imports in both directions, adds same-concept files from other layers and prints the
candidate files with reasons. **It is evidence, not a verdict** – show the candidates and let the user confirm the
scope. If the resolver finds nothing, widen it with `--paths` or `--term`; do not invent a boundary.

Ask, each with a recommended answer:

1. **Slice**: the suggested concept or domain plus its most-used shared library, or a different one? Recommended:
   the suggestion from `repo-map.md` – in a layered repository, prefer the concept slice over the package.
2. **Intent**: a domain model for future work, a map for onboarding, or a backlog for a rewrite? Recommended:
   the domain model first; the other two follow from it.
3. **Language**: confirm `languages.ui` and `languages.artifacts` from the profile. Recommended: what the code
   and UI already use.

Hard rule: **one concept or domain plus at most one shared library per session.** The scope may cross packages
and layers – a domain is not a package. A simple repository without monorepo tooling is one slice only when its
code is not layered; otherwise use the resolver. Never "the whole monorepo"; a shallow map of 80 packages is worse
than a confirmed model of two.

Create `docs/domain/adoption-report.md` with the answers under `## Scope`; fill the rest as you go. If earlier
slices are already adopted, name the next one and what changed since it was adopted (`git log --since=<date>`).

## Phase 2 – Evidence for the slice

Call the `skill` tool for `grilling`, `domain-model` and `architect` first: grilling sets how you ask,
domain-model sets what you are looking for, architect decides what becomes an ADR.

Dispatch `repo-analyst` subagents **in one message**, each with the confirmed scope (the package path or the
resolved file list), the repository map path and one lens. They are read-only. For a concept slice, say which
files are in scope and which layer they belong to; do not let an analyst widen the scope on its own.

- **Monorepo / several packages**: three analysts.
  | Lens | What it looks for |
  |---|---|
  | Structure, data and entry points | Manifests, entry points, schema, migrations, enums, state columns, external services, jobs, the slice's internal dependencies and consumers |
  | Language, behaviour and tests | Nouns and verbs in types, routes, UI texts, errors; handlers, validations, permissions; tests as executable specifications; candidate events/commands/read models |
  | Architecture, dependencies and history | Layering and import direction from `repo-map.md`; build tooling and its graph; de-facto decisions in config; `git log` hotspots, reverted changes, TODOs |
- **Simple repository / no monorepo tooling**: the five lenses from the old adoption (structure and stack,
  domain language, data and integrations, behaviour and tests, history and decisions) – the slice is the whole
  repository.

While they run, read the repository's own documentation yourself. Do not block the round on the analysts.

## Phase 3 – Draft the slice

Merge the reports into one picture. Write the artifacts **as a draft**, every uncertain statement marked.

- **`CONTEXT.md`** – only the slice's terms, grouped by guessed bounded context, competing spellings under
  `_Avoid_`, `[OPEN]` where the meaning is unclear. Do not touch terms of other slices.
- **`docs/domain/events.yaml`** – 10–25 candidate events/commands/actors/read models/policies/flows for this
  slice. Every uncertainty becomes a hotspot (`HS-n`, `status: open`). Every aggregate carries a status:
  `as-is` with `evidence` (table, service method, path) when the code shows a factual consistency boundary, or
  `unresolved` plus an open hotspot when the boundary is unclear. **Never `target` for a boundary inferred from
  code** – a target is a decision the user makes, not a reading of the repository.
- **`docs/domain/context-map.as-is.md`** – the boundaries the module structure actually shows, with evidence.
  Create it from `.claude/skills/adopt/templates/context-map.as-is.md` on the first slice (replace
  `{{project}}`, `{{date}}` and `{{commit}}`) and add one `### BC-… – <name>` section per recovered context
  (the gap register links those headings). **Never write
  `docs/domain/context-map.md`** – that is the target map, owned by `/bootstrap`, `/shape`, `/feature`,
  `/event-storming` and `/improve-codebase-architecture`. If no target exists yet, leave it absent; the gap
  register shows “target not decided”.
- **`docs/architecture/data-model.md`** – the **as-is** model for the slice, derived from schema and code.
- **`docs/engineering/conventions.md`** – fill what the slice actually does: module layout, how a command runs,
  read models, "now", texts, test data, seam catalog. Include how the monorepo tooling is used.
- **`docs/product/vision.md`** – only if missing or empty, reconstruct and mark `[OPEN]`.
- **`docs/adr/`** – de-facto decisions worth recording, `status: proposed`. Only the user accepts.
- **Domain docs** – choose the mechanism by scope, not by habit:
  - **Real domain package** (the code lives in one package): write `<package>/AGENTS.md` + `<package>/CLAUDE.md`
    with `package-doc.ts`:
    ```bash
    node .claude/skills/adopt/scripts/package-doc.ts apps/billing
    node .claude/skills/adopt/scripts/package-doc.ts libs/shared-kernel
    ```
  - **Cross-cutting concept slice** (the domain is spread over `api/`, `services/`, `repositories/`, …): write a
    path-scoped document under `.claude/rules/` instead, so both harnesses load it when a matching file is
    touched:
    ```bash
    node .claude/skills/adopt/scripts/slice-doc.ts order \
      --context BC-Order \
      --paths "src/api/order*,src/services/order*,src/repositories/order*" \
      --title "Order"
    ```
    Do **not** also write a package `AGENTS.md` for the same concept – one mechanism per scope.
  A single-package repository without layers has no package file: its root `AGENTS.md` is the package doc
  (`package-doc.ts .` deliberately refuses). The package script writes `<package>/AGENTS.md` (source of truth) and
  `<package>/CLAUDE.md` (`@AGENTS.md`, for Claude Code's on-demand nested loading). It generates the facts block;
  **you** fill the prose during the grilling:
  - domain/service: Purpose, Key entities, External interfaces, Typical pitfalls, Boundaries
  - shared library: Purpose, Public API, Consumers, Compatibility rules, Typical pitfalls, Boundaries
  Keep each file under ~80 lines. This file is loaded only when someone works in that package or path.
- **Root `AGENTS.md`** – the generated block comes from the map. Below it, add only structure, commands, hard
  conventions and links. Keep at most ten bullets under `## Hard conventions`, each naming where it is enforced
  (`lint`, a test, `.claude/rules/<file>.md`, `docs/engineering/checks.yaml`) – a rule without an enforcement
  point is a wish. **No domain rules, no entities, no business vocabulary** – those belong in `CONTEXT.md` and
  the package docs.
- **`.claude/rules/`** – only for path-scoped rules that cannot be a directory document (e.g. `**/*.sql`,
  `**/migrations/**`), with `paths:` frontmatter. Directory-scoped rules belong in `<dir>/AGENTS.md` because that
  is the mechanism both harnesses load on demand. A rule for a whole group gets `<group>/AGENTS.md` plus a
  one-line `<group>/CLAUDE.md` (`@AGENTS.md`) – e.g. `libs/AGENTS.md` for "everything under `libs/**`". Never
  duplicate the same rule in both mechanisms.

After every write of `events.yaml`, the hook validates and renders it. Fix errors immediately.

### Rules for the draft

- A code name is a *spelling*, never automatically the domain term. `OrderService.place()` is evidence for
  "Order placed", not proof of the word "order".
- One concept with three spellings → one candidate term and two `_Avoid_` entries, or a hotspot.
- Never invent a business rule. If the code enforces something, report it as "the code enforces X (path)"; the
  user decides whether that is a rule or an accident.
- If the repository contradicts itself, that is a hotspot, not a choice you make.

## Phase 4 – Grill the user against the draft

This is the core of the adoption. Present the draft, then work the frontier in rounds exactly as the `grilling`
skill says: numbered questions, each with a recommended answer, whole frontier per round.

Questions brownfield needs, roughly in this order:

1. **Terms** – one question per cluster of competing spellings, worst first.
2. **Boundaries** – which package owns which state; where a shared library ends and a domain begins. For every
   aggregate: is this the factual consistency boundary (`as-is`), is it unclear (`unresolved` + hotspot), or is
   this the boundary we want (`target`, a decision)? Prefer `as-is`/`unresolved` over an invented aggregate.
3. **Lifecycle** – states the schema allows, transitions it does not block.
4. **Invariants** – what the code checks only in the UI; what must always hold.
5. **Missing behaviour** – what has no trace: never needed, or a gap?
6. **Architecture** – layering, CQRS/read models, dependency direction, cross-context communication. Which are
   real decisions and which are accidents? Record the real ones as ADRs.
7. **Build tooling** – how packages are built, tested and filtered; whether affected tests are trustworthy.
8. **Shared libraries** – public API, consumers, what may not break without a migration.
9. **Intent** – which of this is deliberate, and which is legacy you want to leave behind.

Every answer updates the draft **immediately**: `CONTEXT.md`, `events.yaml`, the package's `AGENTS.md`, the ADR.
Resolved hotspots get `status: resolved` + `resolution`. New uncertainty becomes a new hotspot. Do not move on
until the frontier is empty and the user confirms a shared understanding.

## Phase 5 – Safety net: make the confirmed rules checkable

For every confirmed hard rule or invariant, choose the cheapest deterministic enforcement – in this order:

1. **Type system** (a state that cannot be represented cannot be written)
2. **Lint / boundary check** (import direction, layer, package visibility – dependency-cruiser, Nx module
   boundaries, Bazel visibility, ArchUnit, import-linter)
3. **Architecture or characterization test** (a test pins the rule or the existing behaviour)
4. **Hook** (only for fast, edit-time checks; full checks belong in Stop/CI)
5. **Documentation only** (when nothing can check it)

What you may create here:

- 3–5 **characterization tests** for the slice's most important existing behaviour – they pin what is, they do
  not assert what should be.
- The architecture boundaries and checks:
  ```bash
  node .claude/skills/adopt/scripts/boundary-check.ts --init
  # edit docs/architecture/boundaries.yaml with the rules the user confirmed, then
  node .claude/skills/adopt/scripts/boundary-check.ts --update-baseline
  ```
  Run `--init` on the first slice only; later slices extend the existing `boundaries.yaml`. It writes a proposal
  for `docs/architecture/boundaries.yaml`, the default `docs/engineering/checks.yaml` and an empty baseline.
  Rules are evaluated in order; the first matching `from` → `to` pair decides (no match = allow). The engine is
  `scan` for JS/TS imports, or `command` for the project's own tool (dependency-cruiser, Nx module boundaries,
  Bazel, ArchUnit, import-linter).
- `.claude/rules/` entries for confirmed rules that a directory cannot express:
  ```bash
  node .claude/skills/adopt/scripts/rule-doc.ts libs-shared --paths "libs/**" --title "Shared libraries"
  ```
  A rule for a whole directory belongs in `<dir>/AGENTS.md` instead; do not duplicate it in both mechanisms.
- `docs/engineering/checks.yaml` entries with `phase: edit` (fast, changed file only) or `phase: stop` (full set).

What you may **not** do: change production code, or write a test that fails on existing behaviour. On a
brownfield repository the checks are **report-only first**: record existing violations in a baseline, then let
only new violations fail (ratchet). A hook that is red on day one gets switched off.

Hooks are wired once, through the `project-check.ts` dispatcher reading `docs/engineering/checks.yaml`, not by
adding per-package hook entries to `.claude/settings.json`. Keep edit-time checks fast; the full set runs at
Stop/CI. If a rule needs new behaviour, it becomes a story – not a failing test.

## Phase 6 – The gap register (stories only on request)

Compare the confirmed model with the code. Classify, and show the table to the user:

| Class | Meaning | Default |
|---|---|---|
| **Exists and is intended** | Code matches the confirmed model | Documented in the data model/context map. No action. |
| **Exists but contradicts the model** | Code does something the user says is wrong | Candidate in the gap register |
| **Missing** | The model needs it, the code has no trace | Candidate in the gap register |
| **Dead** | Code has no place in the model | Candidate: removal or an explicit "leave it" |

**The default is no stories.** The first adoption pass is about understanding the repo, not about filling a
backlog. Write the table into `docs/domain/adoption-report.md`; open questions go into
`docs/stories/OPEN_QUESTIONS.md` or a hotspot. This keeps the model reviewable without committing to work the
user has not prioritised.

Run the gap register after the grilling and before the report:

```bash
node .claude/skills/adopt/scripts/gap-register.ts
```

Every `as-is` aggregate gets a generated row with its evidence and its as-is/target context links; every
`unresolved` aggregate gets a row that names its open hotspot. Add the decisions outside the managed block.

Only when the invocation contains `--stories`, or the user explicitly asks after seeing the table:

- write the stories yourself as the spec engineer (the `user-stories` skill is the method) with the **selected**
  gaps only, the confirmed IDs from `events.yaml`, `type: domain` with one `command` and its `aggregate`, `ui: true`
  for stories with a frontend part, and the label `adoption:<slug>`;
- new stories start as `status: draft`; the ones the user wants first go through the spec linter and
  `/review-stories`.

**Do not write stories for behaviour that already works** – that turns the backlog into a description of the
past. Existing behaviour is covered by its tests, and the domain model is the map. If an earlier run created
stories the user does not want, do not delete them silently: ask whether to `supersede` them or keep them.

## Phase 7 – Report and the next slice

Write `docs/domain/adoption-report.md`:

```md
# Adoption – <scope>
Date: YYYY-MM-DD · Commit: <sha> · Slice: <paths> · Analysts: <n> lenses

## Scope and intent
## Repository map (tooling, packages, why this slice)
## What the repository is (facts)
## Confirmed domain model
- contexts, aggregates (with status), glossary changes
- as-is context map and the target links the gap register found
## Package documentation written
- <path>/AGENTS.md + CLAUDE.md – what was confirmed and what stays [OPEN]
## Contradictions found and how they were resolved
## Rules and checks
- rule → enforcement (type / lint / test / hook / doc) → baseline or green
## Gap register (candidates – stories only with --stories)
## Deliberately left alone
## Open hotspots
## Next slice
```

Mark the slice adopted so the next session sees the progress:

```bash
# a real domain package
node .claude/skills/adopt/scripts/repo-map.ts --adopt apps/billing

# a concept slice across layers
node .claude/skills/adopt/scripts/repo-map.ts --adopt-slice order
```

Then run `node .claude/skills/event-storming/scripts/validate-events.ts` and
`node .claude/skills/user-stories/scripts/validate-stories.ts`, and show the result.

## Wrap-up

Summarize in a few lines: terms added, contexts/aggregates proposed, hotspots open, package docs written,
checks created, gap candidates (and stories only if requested), ADRs proposed. Then name the next step:

- `git diff` is the review: no production code changed, only docs, package docs and tooling.
- `/adopt <next path>` for the next slice.
- `/feature <idea>` for the next piece of work, now that the domain has a language.
- `/adopt <scope> --stories` (or `/review-stories` if stories already exist) when the user wants the gap turned
  into a backlog.
- `/implement` once a story is `ready`.

## Rules

- **Never change production code in `/adopt`.** Tests and tooling are allowed only as the safety net above.
- **Never present an inference as a fact.** Confidence and evidence, or a hotspot.
- **Aggregates are honest.** `as-is` needs evidence; `unresolved` needs an open hotspot; `target` is a user
  decision. An invented aggregate is worse than an unresolved one – it makes the story look ready when it is not.
- **Adopt writes as-is, never target.** `docs/domain/context-map.as-is.md` and the `as-is` aggregates describe
  the repository. The target map (`docs/domain/context-map.md`) and `target` aggregates are decisions made in
  `/bootstrap`, `/shape` or `/feature` – do not “fix” them while adopting.
- **The user owns the language.** You may propose a better word; you may not rename the domain on your own.
- **Slice by concept, not by package.** In a layered repository a domain runs through `api/`, `services/` and
  `repositories/`. Use the concept clusters and the resolver; never treat a generic `services`/`utils` package as
  a domain just because it has a manifest.
- **Adopt in slices.** One concept or domain plus at most one shared library. Never the whole monorepo in one pass.
- **The root `AGENTS.md` stays free of domain.** Structure, commands, hard conventions and links only.
- **Package docs are short and on demand.** `<package>/AGENTS.md` + `<package>/CLAUDE.md`, under ~80 lines.
- **Directory docs before glob rules.** `.claude/rules/` is for patterns a directory cannot express. Both
  harnesses see the same file: Claude Code scopes it natively by `paths:`, OpenCode's plugin attaches it when a
  matching file is read or written. Directory-scoped rules still belong in `<dir>/AGENTS.md`.
- **No backlog by default.** Adoption produces the model and a gap register; stories are an explicit second step
  (`--stories`) after the user has prioritised.
- **Checks are green on day one.** Baseline existing violations, ratchet new ones; no red hook.
- **The map is generated.** Never hand-edit `repo-map.json`/`repo-map.md` or the generated blocks.
- **Stop when the frontier is empty.** A model that is 80% confirmed and 20% hotspot is more useful than one
  that is 100% invented.
