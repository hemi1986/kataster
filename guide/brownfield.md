# Brownfield: adopting an existing repository

The repository already works. The goal is not a rewrite and not a documentation exercise – it is to recover the
domain the code encodes, in the user's language, and then decide what to build next.

```bash
npx kataster init --brownfield
# in the harness
/adopt                      # map the repository, then choose a slice
/adopt apps/billing         # adopt one package
/adopt libs/shared-kernel   # adopt a shared library
```

## Adopt in slices, not in one pass

A monorepo with eighty packages cannot be understood in one session. `/adopt` therefore works in two levels:

1. **Repository map** – deterministic, no questions: which build tool drives the repository, where the packages
   are, how they depend on each other, which ones change most.
2. **One slice** – one domain plus at most one shared library. Deep evidence, grilling, package docs, checks.
   Then the next slice in a later session.

The map is generated from manifests and git history:

- `docs/architecture/repo-map.json` – packages, paths, kinds, internal dependencies, consumers, adoption ranking
- `docs/architecture/repo-map.md` – the same as a readable map, plus dependency edges and a suggested first slice
- the **repository block in `AGENTS.md`** – tooling, layout, commands, adopted slices
- `.claude/project.json` → `repo.tooling` – Nx, Turborepo, Bazel, pnpm/npm/yarn workspaces, Go, Cargo, Gradle, Maven

The map is facts, not domain. It says where code lives, never what a word means.

## What `/adopt` does

### 1. Chooses the slice with you

The ranking weighs recent churn, fan-in and kind – not size. The suggested slice is usually one domain plus the
shared library it uses most. You can pick another; the rule stays: **one domain, at most one shared library**.

A simple repository without monorepo tooling is one slice – then the whole repository is in scope.

### 2. Reads before it analyses

`CONTEXT.md`, `docs/`, `README*`, `AGENTS.md`/`CLAUDE.md`, existing ADRs. Existing documentation is **primary
evidence** and outranks inference from code. Contradictions between docs and code are findings.

### 3. Dispatches read-only analysts for the slice

A monorepo gets three lenses:

| Lens | Typical evidence |
|---|---|
| Structure, data and entry points | manifests, entry points, schema, migrations, enums, external services, jobs, the slice's dependencies and consumers |
| Language, behaviour and tests | types, routes, UI texts, errors, validations, permissions, tests as executable specifications |
| Architecture, dependencies and history | layering and import direction from the repo map, build tooling, config that encodes a decision, `git log` hotspots |

A small repository without monorepo tooling gets the five classic lenses: structure and stack, domain language,
data and integrations, behaviour and tests, history and decisions.

Each analyst returns facts with `path:line`, candidate vocabulary, candidate events/commands/read models,
contradictions, and questions with a recommended answer. Confidence is `high`, `medium` or `low`.

### 4. Drafts the slice

- `CONTEXT.md` – the slice's terms, competing spellings under `_Avoid_`
- `docs/domain/events.yaml` – 10–25 candidate events, commands, actors, read models, flows, hotspots
- `docs/domain/context-map.md`, `docs/architecture/data-model.md` (as-is)
- `docs/engineering/conventions.md` – how the code actually works today, including the monorepo tooling
- `docs/adr/` – de-facto decisions worth recording (`status: proposed`)
- **package docs** – `<package>/AGENTS.md` plus `<package>/CLAUDE.md`, written by
  `node .claude/skills/adopt/scripts/package-doc.ts <path>`

Everything uncertain is marked. The draft is a proposal, not a verdict.

### 5. Grills you against the draft

This is the core. Rounds of numbered questions on the frontier, each with a recommended answer:

> **Q1 – One concept, three names.** You call it `Order`, `Purchase` and `Checkout` in three places
> (`src/orders/*`, `src/api/checkout.ts`, `messages/en.json`). Is it one concept, and which is the domain word?
>
> ➡️ One concept, "Order"; `Checkout` is the UI action, `Purchase` should be avoided.

Answers update `CONTEXT.md`, `events.yaml` and the package's `AGENTS.md` immediately. Resolved hotspots get a
resolution; new uncertainty becomes a new hotspot.

### 6. Builds the safety net

For every confirmed hard rule, choose the cheapest deterministic enforcement: type system, lint/boundary check,
architecture or characterization test, hook, or documentation only. Brownfield checks start **report-only** with a
baseline of existing violations; only new violations fail. A hook that is red on day one gets switched off.

`/adopt` may add characterization tests and tooling. It never changes production code, and it never writes a test
that fails on existing behaviour – that would be a story.

### 7. Records the gap – stories only on request

| Class | Default |
|---|---|
| Exists and is intended | Documentation (data model, context map) – no action |
| Exists but contradicts the model | Candidate in the gap register |
| Missing | Candidate in the gap register |
| Dead | Candidate: removal or an explicit "leave it" |

**The first adoption pass creates no stories.** It records the gap in `docs/domain/adoption-report.md` (and open
questions in `OPEN_QUESTIONS.md`), so the model can be reviewed before anyone commits to work. Only
`/adopt <scope> --stories` (or an explicit "turn these into stories") delegates the selected gaps to
`requirements-engineer`.

**Behaviour that already works does not become a story.** That turns the backlog into a description of the past.

### 8. Writes the report and marks the slice adopted

`docs/domain/adoption-report.md`: scope, map and slice, facts, confirmed model, package docs, contradictions, rules
and checks, gaps, what was deliberately left alone, open hotspots, next slice.

```bash
node .claude/skills/adopt/scripts/repo-map.ts --adopt apps/billing
```

The next session sees the progress in `AGENTS.md` and the map, and starts the next slice with
`/adopt <path>`.

## What lives where

| File | Loaded | Contains |
|---|---|---|
| `AGENTS.md` (root) | every session | repository structure, commands, hard conventions, links – **no domain** |
| `<package>/AGENTS.md` | when working in that package | purpose, key entities or public API, interfaces, pitfalls, boundaries |
| `<package>/CLAUDE.md` | same, for Claude Code | one line: `@AGENTS.md` |
| `<group>/AGENTS.md` | when working under that group | rules for a whole group, e.g. `libs/**` – plus `<group>/CLAUDE.md` |
| `.claude/rules/*.md` | when a matching file is touched (both harnesses) | path-scoped rules for patterns a directory cannot express |
| `docs/architecture/boundaries.yaml` | on demand / on check | allowed and forbidden dependency edges (first match wins) |
| `docs/architecture/boundaries.baseline.json` | on check | existing violations, so only new ones fail |
| `docs/engineering/checks.yaml` | on check | what runs at edit time and at Stop/CI |
| `docs/architecture/repo-map.md` | on demand | generated map: packages, edges, consumers, ranking |
| `CONTEXT.md` | every session | the domain language |

Nested `AGENTS.md` is loaded on demand by OpenCode; Claude Code loads the nested `CLAUDE.md` when it reads or
edits a file there. That is why every package gets both files.

## Monorepos and shared libraries

The detected tool is used, not re-implemented:

| Tool | One package | Affected only |
|---|---|---|
| Nx | `nx run <project>:test` | `nx affected -t test` |
| Turborepo | `turbo run test --filter=<package>` | `turbo run test --filter='...[HEAD^1]'` |
| Bazel | `bazel test //<package>/...` | – (query at work time) |
| pnpm | `pnpm --filter <package> test` | `pnpm -r --filter '...[HEAD^1]' test` |
| npm/yarn workspaces | `npm run test --workspace <package>` / `yarn workspace <package> test` | – |
| Go / Cargo / Gradle / Maven | language-specific, in the package doc | – |

When a shared library changes, its consumers from the map are the first thing to check; run their tests or the
affected set. The library's `AGENTS.md` records its public API, consumers and compatibility rules.

The map asks the build tool for its own graph and stores it as an optional `toolGraph` next to the manifest
graph – Turborepo via `turbo run <task> --dry=json`, Nx via `nx graph --file=<temp>`, Bazel from the `deps`
attributes in `BUILD`/`BUILD.bazel`. The fast loop then uses it:

```bash
# which packages are affected by these files, including shared-library dependents?
node .claude/skills/implement/scripts/affected.ts --changed libs/shared-kernel/src/index.ts

# or against a base ref; the tool's native affected filter is emitted
node .claude/skills/implement/scripts/affected.ts --base origin/main

# execute the printed command
node .claude/skills/implement/scripts/affected.ts --changed apps/billing/src/index.ts --run
```

The output is a native command: Turborepo gets `turbo run test --filter=…`, Nx `nx run-many -p …` or
`nx affected`, Bazel `bazel test //pkg/...`, and so on. Nx project names are resolved from the graph, so
`billing` and `@acme/billing` do not have to match. If the tool is not installed (or does not answer), the
manifest graph is used instead – the workflow never depends on the tool being present.

## Rules, boundaries and checks

Confirmed architecture rules become deterministic, not prose:

```bash
node .claude/skills/adopt/scripts/boundary-check.ts --init
# edit docs/architecture/boundaries.yaml with the rules the user confirmed
node .claude/skills/adopt/scripts/boundary-check.ts --update-baseline
node .claude/skills/adopt/scripts/boundary-check.ts
```

`boundaries.yaml` holds edges, not stories:

```yaml
version: 1
engine: auto          # scan JS/TS imports, or command for your own tool
command: ""
rules:
  - id: shared-libs-are-leaves
    from: "libs/**"
    to: ["apps/**", "services/**"]
    effect: deny
    reason: "Shared libraries never import applications or services."
```

Rules are evaluated in order; the first matching `from` → `to` pair decides, no match means allow. The `scan`
engine reads JS/TS imports; `command` runs dependency-cruiser, Nx module boundaries, Bazel, ArchUnit,
import-linter or your own script and ratchets its failure output.

**Baseline/ratchet:** `--update-baseline` freezes what already exists. After that only new violations fail, so a
brownfield repository is green on day one and the baseline shrinks over time. The checks are wired once through
`project-check.ts`; `docs/engineering/checks.yaml` decides which check runs at edit time (changed file only) and
which at Stop/CI.

Path-scoped rules that a directory cannot express get a file with `paths:`:

```bash
node .claude/skills/adopt/scripts/rule-doc.ts libs-shared --paths "libs/**" --title "Shared libraries"
```

A rule for a whole directory belongs in `<dir>/AGENTS.md` (plus its one-line `CLAUDE.md`) – that is the mechanism
both harnesses load on demand. Path-scoped rules are read natively by Claude Code; in OpenCode the plugin attaches
the matching rule as session context as soon as a file under its globs is read or written.

## Rules that make adoption work

- **Adopt in slices.** One bounded context completely beats the whole repository shallowly.
- **Code names are evidence, not language.** `OrderService.place()` suggests "Order placed"; the user decides.
- **Never change production code.** The output is language, model, decisions, docs and checks.
- **An 80% confirmed model with 20% hotspots beats a 100% invented one.**
- **The user owns the language.** Propose a better word; don't rename the domain alone.
- **The root `AGENTS.md` stays free of domain.** Structure and commands only.

## After adoption

```bash
git diff                    # only CONTEXT.md, docs/, package docs and tooling changed
/adopt <next>               # next slice
/adopt <scope> --stories    # turn the selected gaps into stories, when you want a backlog
/feature <idea | ticket>    # next work, now that the domain has a language
/shape <large idea>         # new service/context/migration: placement, impact, slices, cost range
/implement                  # once a story is ready
```

With a tracker (`backlog.provider` = `github` or `jira`), pull before adopting or reviewing and push the derived
stories afterwards. The tracker is the source of truth; `docs/stories/` is the mirror.
