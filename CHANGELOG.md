# Changelog

## Unreleased

- **Removed the optional extras and the vendored `shadcn` skill.** `--with` is gone; the CLI fails with a clear
  message instead of reading the value as a directory. The payload no longer ships third-party content: install a
  UI skill such as shadcn/ui in the project that needs it. An installation made with `--with shadcn` keeps the files
  under `.claude/skills/shadcn/`; `upgrade` leaves them alone and drops the stale `workflow.extras` field from
  `.claude/project.json`.

## 0.2.1 – 2026-10-31

- Releases are published from CI with npm trusted publishing (OIDC): pushing a `v*` tag runs the type check and the
  test suite, verifies that the tag matches `package.json`, and publishes with provenance attestations – no token
  in the repository, no one-time password. `guide/release.md` documents the setup and the manual fallback.
- The repository is maintained in the open: `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, issue and pull
  request templates, Dependabot for the tooling dependencies and a protected `main` (pull request required, green
  CI, squash only).

## 0.2.0 – 2026-10-31

- **Renamed from La Guardia to Kataster.** The CLI is `npx kataster`, the state directory is `.kataster/`, the
  managed block markers are `kataster:*`, the OpenCode adapter lives in `.opencode/plugins/kataster/`, the env var is
  `KATASTER_NODE` and the default backlog label prefix is `kataster`. `upgrade` migrates an existing installation in
  place (state directory, plugin path, markers in `AGENTS.md`/`CLAUDE.md`, `.gitignore`); `doctor` reports leftovers.
  An existing `.claude/project.json` keeps its own `backlog.labelPrefix`, so labels already in GitHub or Jira stay
  valid – rename them by hand if you want them to follow.

- New `/shape` skill: the step between an idea and `/feature`. It grills a large idea, places it (existing or new
  bounded context, shared library), maps change vs. new work, slices it, and produces a cost range with basis and
  confidence. It creates no stories; the brief lives in `docs/product/initiatives/<slug>.md` and ends with one
  recommendation (go / slice 1 / spike / discover / park / no-go). `--dry-run` writes nothing. A partially adopted
  repository or an analogous service is used as evidence, never as a template.
- `/feature` accepts a reference: `ST-NNN`, `#issue`, a Jira key or URL, or a Jira issue exported through MCP.
  A read-only `feature/scripts/intake.ts` resolves it, finds the linked local story by id or `external`, and returns a
  route – continue a draft, review, implement, treat finished behaviour as a new story, send a bug to a regression
  story, or run the feature pipeline. The ticket is evidence, not a specification: criteria are grilled, the source
  is recorded in the story, and `external` stays owned by the backlog sync.
- Brownfield adoption in slices: `/adopt` now builds a deterministic repository map first
  (`docs/architecture/repo-map.json`/`.md`), then adopts one domain plus at most one shared library per session.
  The map knows packages, internal dependencies, consumers and an adoption ranking.
- Monorepo tooling detection (Nx, Turborepo, Bazel, pnpm/npm/yarn workspaces, Go, Cargo, Gradle, Maven) in
  `.claude/project.json` → `repo.tooling`; commands per package and affected tests use that tool.
- Per-package docs: `<package>/AGENTS.md` (purpose, entities or public API, interfaces, pitfalls, boundaries) plus
  a one-line `<package>/CLAUDE.md` importing it, so Claude Code and OpenCode load them only when working there.
  The root `AGENTS.md` stays free of domain and keeps structure, commands and hard conventions.
- An existing `CLAUDE.md` now gets the `@AGENTS.md` import without losing its house rules; without the import,
  Claude Code would read only the project's own file and never load the workflow instructions.
- Brownfield adoption no longer creates stories by default. It records a gap register in the adoption report;
  `/adopt <scope> --stories` turns the selected gaps into a backlog when the user wants one.
- The installer preserves project hooks under `.claude/hooks/` on upgrade; only its own exact hook commands are
  replaced.
- `verify.ts` warns when the generated repository map is stale.
- Architecture boundaries as data: `docs/architecture/boundaries.yaml` (first matching `from` → `to` rule wins),
  a JS/TS import scanner or a `command` engine for dependency-cruiser, Nx, Bazel, ArchUnit, import-linter, and
  `docs/architecture/boundaries.baseline.json` for baseline/ratchet. `--init` writes a proposal; existing
  violations are frozen; only new ones fail.
- `docs/engineering/checks.yaml` and the `project-check.ts` dispatcher: project-owned checks run at edit time
  (changed file only) and at Stop/CI. Wired once in Claude Code and OpenCode, never per package.
- `rule-doc.ts` scaffolds and validates `.claude/rules/*.md` with `paths:` frontmatter; directory rules stay in
  `<dir>/AGENTS.md` so both harnesses load them on demand.
- Turborepo tool graph: `repo-map.ts` asks `turbo run <task> --dry=json` for the real package/task edges and stores
  them as an optional `toolGraph`; without Turbo it falls back to manifests. `affected.ts` maps changed files (or
  `--base`) to affected packages, follows dependents of shared libraries, and emits the native Turbo/Nx/Bazel/pnpm
  command; `--run` executes it. `/implement` uses it for the fast loop, `verify.ts` remains the full gate.
- Nx and Bazel tool graphs: `nx graph --file=<temp>` is resolved to package names (Nx project names need not match,
  e.g. `billing` vs `@acme/billing`) and kept in `toolGraph.projectNames` so `affected.ts` emits
  `nx run-many -p billing,…`; Bazel packages and edges come from the `deps` attributes in `BUILD`/`BUILD.bazel`,
  so no Bazel server or toolchain is needed. Both stay enrichment: no tool, no graph, manifest fallback.
- Path-scoped rules in both harnesses: `.claude/rules/*.md` stays the single source of truth, Claude Code scopes
  it natively by `paths:`, and the OpenCode plugin calls the new `path-rules.ts` hook whenever a file is read or
  written to attach each matching rule once per session as a keyed instruction entry. The rule body is sent
  without its frontmatter; the scope is stated in the first line.
- Backlog backends: stories can stay local (default), live in GitHub Issues (`gh`) or in Jira (`mcp-atlassian`).
  With a tracker, `docs/stories/` is a synchronized local mirror, `ST-NNN` stays the stable id and the tracker key
  lives in `external`. Only the backlog core syncs; reviews and open questions stay local.
- New `backlog` skill and `/backlog-sync` command: status, pull and push, with conflict detection, backups and a
  three-way sync state. GitHub syncs deterministically; Jira is driven through MCP with plan/record/import scripts.
- `kataster init --backlog local|github|jira`, provider config in `.claude/project.json`, `doctor` checks for `gh`,
  the Jira project and the MCP server.
- Story schema and validator understand `external` and refuse a `ready`/`in-progress`/`done` mirror story without a
  tracker link.

## 0.1.0 – 2026-10-29

First standalone release.

- `kataster init | upgrade | doctor` with stack detection, project profile and idempotent install
- Merges into existing `AGENTS.md`, `.claude/settings.json`, `.opencode/opencode.jsonc` and `.gitignore`
- Greenfield entry point `/bootstrap`: vision grilling → event storming → domain model → architecture → UX →
  foundation stories
- Brownfield entry point `/adopt`: five parallel `repo-analyst` lenses → evidence-based domain draft → grilling →
  gap stories
- `repo-analyst` agent (read-only) for OpenCode and Claude Code
- Project profile `.claude/project.json` replaces hardcoded project assumptions; `verify.ts` runs its commands
- `docs/engineering/conventions.md` replaces the project-specific conventions skill; the original is kept in
  `examples/` as a reference
- Optional `shadcn` skill moved to `extras/` (`--with shadcn`)
- Guardrails generalized: deploy providers, database tools, default branch from the profile
