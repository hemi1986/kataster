# Engineering conventions – {{project}}

<!--
  How the code is built here. The ADRs decide WHAT; this file says HOW. `/adopt` fills it from the
  existing codebase; a greenfield project writes it after the first foundation stories, when the shapes
  actually exist (not before).

  Keep it factual and short enough to be read before writing a story. When code and this file disagree,
  raise it – don't silently follow either.

  It must answer, for this repository:
-->

## Module layout

[OPEN] Which directories exist, what belongs in each, and which imports are allowed across them?

## Monorepo and shared libraries

[OPEN] Which tool builds and tests across packages (Nx, Turborepo, Bazel, pnpm/npm/yarn workspaces, Go, Cargo,
Gradle, Maven)? How do you run one package, and how do you run only affected tests? What may a shared library
import, and who are its consumers? The generated overview is in `docs/architecture/repo-map.md`; `repo-map`
stores the build tool's graph (Turbo, Nx, Bazel) and `affected.ts` turns changed files into the native command.

## Architecture enforcement

[OPEN] Which rules are checked deterministically, and where? `docs/architecture/boundaries.yaml` holds the
allowed/forbidden edges (first match wins), `docs/engineering/checks.yaml` decides what runs at edit time and at
Stop/CI, and `.claude/rules/*.md` holds path-scoped rules a directory cannot express. Existing violations live in
`docs/architecture/boundaries.baseline.json`; only new ones fail. Name the engine for non-JS/TS stacks
(dependency-cruiser, Nx module boundaries, Bazel, ArchUnit, import-linter).

## Commands and events

[OPEN] How does a command run (transaction, authorization, version check)? Where do domain events go?
How are automatic policies triggered? What is the ID convention?

## Read models

[OPEN] Where do queries live, and how do they stay out of the write path?

## Time-based rules

[OPEN] How is "now" injected, so due/overdue rules are testable?

## UI and texts

[OPEN] Where do texts live, which language(s), which shared components/frames exist?

## Test data and seams

[OPEN] Test data builders, fixed clock, database per test run.

### Seam catalog

Which seam each kind of code is tested at. `/implement` only stops for the user when a seam is missing here.

| Kind of code | Seam | Test type | Example |
|---|---|---|---|
| Pure domain rule | the rule's public function | unit | – |
| Command | the command through its public interface | integration | – |
| Read model | the query | integration | – |
| Page, form, flow | the browser | e2e | – |
