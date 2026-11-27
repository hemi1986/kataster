# Changelog

## Unreleased

### Fixes

- **The repository map keeps concept slices adopted by meaning.** A slice marked with `repo-map.ts --adopt-slice
  <name>` whose name matches no generated cluster (`/adopt` names a domain by meaning, the scanner a cluster by file
  stem) was dropped by the next `repo-map.ts` run, and marking it again made `--check` report the map as stale – so
  the `/marathon` merge gate refused every merge. A refresh now keeps an adopted slice the scan no longer produces,
  unchanged and with its `adoptedAt`; the write and `--check` share one carry-over (`refreshRepoMap` in
  `lib/repo.ts`).
- **Git-ignored directories are not scanned.** Build output git ignores (e.g. a `runtime/` directory holding a copy
  of the workspace) no longer adds duplicate packages and cluster files to the map, so `--check` no longer depends
  on what happens to be built locally. One `git ls-files --ignored` call per scan; without git the fixed list of
  build directory names applies as before.

## 0.7.0 – 2026-11-26

A minor release with three new features – story metrics, the worker mode of `/implement` and the marathon run – and a
few changed defaults. **Read *Behaviour changes* before you upgrade from 0.6.x.**

### New

- **Story metrics.** `story-metrics.ts mark <ST-NNN|feature:<slug>> <phase> start|end` marks a phase; `/shape`,
  `/feature`, `/review-stories` and `/implement` mark theirs. Tokens (input, output incl. reasoning, cache
  read/write), model, harness, agent time and user wait time land append-only in `docs/stories/metrics/`, one entry
  per pass, stream and model; tokens outside every phase go to an `unassigned` pot. Claude Code is read from the
  transcripts (with `subagents/`), OpenCode from its database (read-only, `node:sqlite`, child sessions included).
  - `story-metrics.ts report [--story|--feature|--since] [--json]` prices the tokens from `metrics.prices` in
    `.claude/project.json` (no built-in prices – an unpriced model shows `–`), splits a feature's spec cost across
    its stories and compares `size` with the actual cost. `collect --since <ISO time>` finalises every session with a
    marker since then, idle or not.
  - `story-metrics.ts review ST-NNN <agent> --verdict … --blocker … --major … --minor … --question …` records one
    review: who reviewed, the verdict, the findings per severity. `/implement` records its reviews this way.
- **Worker mode for `/implement`.** `/implement --worker ST-NNN --base <branch>` builds one given story for an
  orchestrator, with no auto-pick and no `git pull`: the story branch is cut from `--base`, then context pack, test
  plan, characterization, red → green and `verify.ts` run as in the manual mode. The worker starts no reviews and no
  subagents (enforced by the new `story-worker` agent in both harnesses) and returns a JSON report instead of asking:
  `ready-for-review`, `blocked` or `returned-to-review`. A technical detail the story and the conventions leave open
  is settled with a conservative default and listed under `decisions`; a domain gap is `blocked`, never decided in
  code. `worker.ts start|report` read the facts from git and the last verify run, and `report` refuses a result they
  contradict. The manual mode is unchanged by this.
- **Merge blockers.** Security and data protection (personal data exposed, a missing authorization check,
  injection), a 5xx answer to client input and an inconsistency that breaks a domain rule (a uniqueness that
  normalisation gets around) are never a default, a skipped finding or an open question. Reviewers tag them
  `merge-blocker: <kind>`, and **only the tag blocks**. A text net also finds untagged look-alikes; it never blocks,
  it only lists them (in a marathon: *Possible merge blockers – please check* in the pull request).
- **`/feature` grills input and errors** (accepted values, limits, normalisation, error behaviour per command), and
  the conventions template has a matching *Input and errors* section, including the time zone of "today".
- **Marathon run (experimental, see below).** `/marathon` makes the main session the orchestrator of an unattended
  run in both harnesses: it plans and claims story after story, hands each to a `story-worker`, runs the reviews,
  merges accepted stories into `marathon/<date>`, verifies there and ends with one pull request to the default branch
  (a draft after a red verify) listing the escalations, open questions, defaults to confirm and the stories' metrics.
  You merge. `marathon-plan.ts` plans the next story; `marathon-state.ts` is the only writer of the run's state.

### Marathon is experimental

- **Serial only.** One worker at a time; `--n` other than 1 is refused.
- **The merge-blocker rules have not been through a real run yet** – only the test suite has exercised them.
- **An unattended run needs narrowly scoped permissions.** Set them before you leave a run alone – see
  [README → Permissions for an unattended run](https://github.com/hemi1986/kataster/blob/main/README.md#permissions-for-an-unattended-run). Pattern rules and the
  Kataster hooks are guard rails, not a sandbox.

How a run protects itself:

- **Stops** when nothing is left to plan, a limit (stories, failures in a row) or the optional token/cost budget is
  reached, after the foundation tasks when a different story is next (`--no-gate-foundation` turns that off), or at
  once on a red verify of the integration branch. `/marathon resume` goes on with a run that was cut off, also in the
  other harness.
- **One session at a time.** A lease records the orchestrator and each story's worker; a replaced session is refused
  by the scripts and blocked on every tool call by `marathon-guard.ts`. Scheduling work for later is blocked while a
  run runs. A worker's report is kept, so a resumed run reads it instead of starting another pass.
- **Merge gate.** `result … merged` is checked against git and the last verify run, and refuses a missing acceptance
  (below), a stale repository map and an open tagged merge blocker (`merge-check` refuses it before `git merge`). A
  merge blocker gets one fix pass and the same reviewer again; still there, the story is escalated.

### Behaviour changes – check when you upgrade

- **OpenCode automations are off by default.** `.opencode/opencode.jsonc` ships `"automations": false`, and
  `upgrade` adds it where none of your OpenCode configs sets the key. An automation runs later, outside the session's
  permissions and the Kataster hooks; in a marathon test run an agent whose shell commands were denied used
  `automation.create` to get around them.
  **Migration:** if you use automations, set `"automations": true` – before or after the upgrade; your value is kept.
- **A marathon merges no `domain`, `tech-task` or `spike` story without an accepting `acceptance-tester` review.**
  Only `chore` and `task` take the fast lane. This is a gate of the marathon run; the manual `/implement` has no new
  gate (the acceptance tester's verdict already is the acceptance there).
  **Migration:** none. If a story should skip the acceptance, it has to be a real `chore` or `task`.
- **The reviewers are stricter, in the manual mode too.** A merge blocker is a `blocker` for `code-reviewer` and
  `not accepted` for `acceptance-tester`, even where no rule of the story names it, and `/implement` never skips it.
  **Migration:** none; expect findings (for example a 500 on a malformed body) that used to be remarks.
- **New story field `feature: <slug>`.** `/feature` writes it next to the `feature:<slug>` label; the metrics report
  uses it. The linter now **errors** on more than one `feature:` label and on a field that does not match the label,
  and warns about a label without the field.
  **Migration:** run `npx kataster lint-story`; add `feature: <slug>` to stories that have the label, and keep one
  feature label per story.
- **Detail files instead of heredocs.** The new skills pass JSON to the scripts as files under `.kataster/details/`
  (git-ignored), because Claude Code refuses a heredoc in `dontAsk` mode.
  **Migration:** none from 0.6.3, whose skills used no heredocs. Skills or scripts of your own that call
  `worker.ts` or `marathon-state.ts` should pass `--details <file>`.
- **OpenCode now mirrors Claude Code's allow list – without loosening yours.** The workflow scripts,
  `git status/diff/log` and `gh issue/label` become `shell` allow rules in `opencode.jsonc`. An upgrade never makes
  your permissions weaker:
  - **Your `deny` always wins**, `shell * deny` included.
  - **Your `ask` yields only to Kataster's own scripts** (`node .claude/skills/*/scripts/*`). For `gh issue`,
    `gh label`, `git` and every other command it stays.
  - OpenCode applies the **last** matching rule, so a Kataster rule that would override one of yours is added **in
    front of it**. OpenCode also reads `opencode.json[c]` at the root and in parent directories and the older
    `permission` and `tools` keys *before* the list in `.opencode/opencode.jsonc`; a rule that would override one of
    those is **not added**. The same when such a file cannot be read.
  - `upgrade` lists what it held back, and `kataster doctor` warns for each of your rules that takes a Kataster rule
    out of work and says what follows (for example *the backlog sync will ask for approval*). It also warns when one
    of your rules stands *before* a Kataster rule that overrides it.
  - Your global OpenCode config (`~/.config/opencode`) is not part of the project and is not considered here:
    OpenCode applies the project's rules after it.

  Claude Code gains allow entries for the `metrics` and `marathon` scripts; there your `deny` and `ask` win anyway,
  and they stay as you wrote them.
  **Migration:** nothing is required. Run `npx kataster doctor`; to let a command run that one of your rules holds,
  move the Kataster rule behind yours (or change yours) – the upgrade keeps the order you choose.
- **More hooks, and metrics files to commit.** `.claude/settings.json` and the OpenCode plugin run `metrics.ts`
  (session start and end, shell calls, permission prompts – it adds the caller's session id to the scripts' marker
  commands) and `marathon-guard.ts` (inactive without a run). The workflow skills write
  `docs/stories/metrics/*.json`; commit them. `/implement` and `verify.ts` ignore uncommitted ones.
  Both harnesses check permissions against the rewritten command, so a command that a `deny` or `ask` rule of yours
  matches only as written is **not** rewritten – your rule applies. (If you then approve such an `ask`, that call
  runs without the caller's id: no marathon lease check and no token attribution for it.)
- **Project files are not rewritten.** `docs/workflow.md`, `docs/engineering/conventions.md` and the story README are
  yours. **Migration (optional):** compare them with `templates/` for the new *Input and errors* section and the
  worker/marathon flow.

### Fixes

- **`init` and `upgrade` no longer delete your Claude Code permissions.** A `.claude/settings.json` that is not plain
  JSON – a comment, a trailing comma, a byte order mark – was treated as empty and **overwritten**, with your `deny`,
  `ask`, `allow` and hooks. It is now left untouched; the run says so, `doctor` fails until the file is plain JSON,
  and the next upgrade wires the hooks in. This affects 0.6.3 and earlier: **if you installed or upgraded over such a
  file, compare `.claude/settings.json` with your git history.**
- **The Stop gate no longer loses the first changed file.** `stop-gate.ts`, `characterize.ts` and `affected.ts`
  trimmed the output of `git status --porcelain` before cutting off the status columns, which shifted the path of an
  unstaged file: the Stop gate skipped the first modified file (and ran nothing when it was the only one), and
  `affected.ts` lost every unstaged modification. All three now read `git status --porcelain -z` through
  `changedPaths()` in `lib/git.ts`.
- **`upgrade` keeps your comments in `opencode.jsonc`.** It parsed and re-serialised the file, so every comment and
  your formatting were lost. It now inserts only what is missing and leaves everything else byte for byte. Comments an
  earlier upgrade removed are not restored – take them from git history.
- **No npm warning about the `bin` path** when publishing.

## 0.6.3 – 2026-11-22

Follow-ups from the 0.6.2 upgrade report in #8.

- **`upgrade` keeps deleted files deleted.** A workflow file or docs skeleton file the project deleted is no longer
  re-created; `.claude/install.json` remembers it under `deleted`, and the skeleton files the installer created under
  `seeded`. `upgrade --restore` brings them back. Without `.claude/package-lock.json` the tooling install runs with
  `--no-package-lock`. `doctor` fails when a deleted workflow file is still referenced, e.g. a hook in
  `settings.json`. An installation from before this version counts a missing skeleton file as deleted.
- **Backlog scripts no longer run on `--help`.** `backlog-push`, `backlog-pull`, `backlog-status`, `jira-plan`,
  `jira-record` and `jira-import` print their usage for `--help`/`-h` and reject an unknown argument with exit 2
  before touching the tracker or the mirror.

## 0.6.2 – 2026-11-22

Follow-ups from #8.

- **Language rule for templates (#9).** The installed templates are English and are translated as they are filled.
  What scripts read stays English: frontmatter keys and values, the parsed headings and markers (listed in
  `docs/workflow.md`), Gherkin keywords and IDs. ADRs follow the artifact language.
- **Editorial edits to accepted ADRs (#10).** `protect-files` allows an edit that keeps `status: accepted`, keeps
  the `## Editorial changes` log and adds a dated line to it. A changed decision is still a new ADR.
- **Lint and format configs (#11).** `init` prints the ignore entries Prettier, ESLint and the root `tsconfig.json`
  need for Kataster's files, and `doctor` warns about missing ones. Neither edits a user's config.

## 0.6.1 – 2026-11-22

Fixes from a greenfield trial with German artifacts (#8).

- **The backlog pull keeps every field.** `backlog-pull` rebuilt the frontmatter from a fixed key list and dropped
  `aggregate`, `command`, `ui` and any other key, so domain stories failed the linter after a pull. It also wrote
  defaults such as `context: ""` into stories that never had them. A push followed by a pull now leaves the content
  unchanged.
- **Formatters no longer make the story mirror drift.** The sync compares the parsed frontmatter and the normalized
  body instead of bytes, so a formatter changing quote style or list layout is not a local change. Byte hashes in an
  existing `backlog-sync.json` still match.
- **The story sentence in the artifact language.** The linter accepts the form for `languages.artifacts` (built in:
  `de`, `Als <Rolle> möchte ich <Ziel>, damit <Nutzen>`) and custom regular expressions from
  `stories.sentencePattern`. English stays valid. Section headings, Gherkin keywords and IDs stay English.
- **`bash-guard` checks only the command that runs.** Quoted prose, `echo`/`printf`, commit messages and heredoc
  bodies no longer trigger it; `$(…)`, backticks, `bash -c` and `eval` are still checked, and quoted tokens such as
  `"--prod"` and SQL in a heredoc are now caught.
- **Smaller fixes.** The glossary language check skips `.opencode/` and `.kataster/`. `doctor` lists ADRs whose
  `status` is not in the frontmatter, because `protect-files` cannot protect them. `init` says when `--greenfield` or
  `--brownfield` overrides the detection. `domain-architect` knows it has no shell and leaves formatting to the main
  session.

## 0.6.0 – 2026-11-07

- **Research as evidence.** New read-only `researcher` agent (Claude Code and OpenCode) that searches specs,
  standards and exact-version official documentation and returns structured findings with source, retrieval date,
  tier and confidence – no writes, no shell, no decisions. `/research <question>` runs the workflow directly;
  `/feature --research` forces the step when the trigger list (auth/identity, security, payment, privacy,
  accessibility, performance, new technology) would not catch it.
- **Persisted research files.** Findings live in `docs/research/<topic>.md` with `topic`, `question`, `created`,
  `retrieved`, `expires` and `stack`; the main session writes them verbatim and computes `expires` from
  `research.expiryMonths` (default 12, month-end clamped). `research-check.ts` validates the format and expiry
  (`--topic`, `--referenced`, `--all`, `--json`) and `verify.ts` runs the referenced check as an advisory step.
- **Deterministic research gate.** Stories can cite `sources:` (an `https://…` URL or a local research file). A story
  with `risk: high` or a configured gate label (`security`, `auth`, `payment`, `privacy` by default, matched exactly
  or by prefix) needs at least one resolvable source before `ready-for-human-review`; `lint-story` warns for
  `draft`/`review`, `story-status.ts` and the validation hook block the transition. Existing `ready`/`done` stories
  stay green, and expiry is a warning, never a gate error. `sources` survives the GitHub/Jira backlog round-trip and
  appears in the implementation context pack.
- **Grilling integration.** `grilling`, `feature`, `shape`, `user-stories`, `review-stories` and `implement` cite
  research findings instead of inventing "best practice"; a finding that contradicts the model is a grilling
  question. `shape` adds `## Evidence` to the initiative and uses findings as a cost anchor, never as the estimate.
  The payload ships `templates/docs/research/README.md`, the research skill and template, and the installer allows
  the research scripts.

## 0.5.0 – 2026-11-07

- **Honest aggregate status.** Aggregates in `docs/domain/events.yaml` can be `target` (the default when the field
  is missing), `as-is` (a factual brownfield boundary, with `evidence`) or `unresolved` (the boundary is unclear
  and needs an open hotspot). The validator rejects `as-is` without evidence; the spec linter blocks a story on an
  `unresolved` aggregate from leaving `review`. `/adopt` and `domain-model` prefer `as-is`/`unresolved` over an
  invented aggregate.
- **Gap register.** `docs/domain/gap-register.md` gets one generated row per `as-is`/`unresolved` aggregate,
  linking the aggregate and both context maps. The managed block is refreshed by
  `node .claude/skills/adopt/scripts/gap-register.ts`; decisions live outside it.
- **Slices by concept, not by package.** The repository map marks generic layer packages (`services`,
  `repositories`, `utils`) instead of proposing them as domains, and clusters files by shared concept stems and
  tables. `/adopt` accepts a package path, `--paths`, `--route`, `--table`, `--event`, `--cluster` or a term;
  `slice.ts` resolves the candidate files across layers and the user confirms the scope. A cross-cutting slice
  documents its domain in `.claude/rules/<context>.md` with `paths:`; `<package>/AGENTS.md` stays for real
  domain packages.
- **Characterization tests before test-first.** `characterize.ts --story ST-NNN` (or `--changed`/`--base`) names
  the affected source files and the tests it finds. In the domain lane, an affected path with no test for the
  behaviour about to change gets a characterization test first: current behaviour pinned, green on unchanged code,
  committed separately, then the story tests. A discrepancy is a finding – the story goes back to `review`, never
  the test to the expected value. The fast lane skips this except for an explicit refactoring.
- **As-is and target are separate.** `docs/domain/context-map.md` is the target map; `/adopt` writes only
  `docs/domain/context-map.as-is.md` and links both through the gap register. `/shape` and
  `/improve-codebase-architecture` write the target map; `/bootstrap`, `/feature` and `domain-architect` do the
  same. Existing projects keep their `context-map.md` as the target – no file is moved or renamed.

## 0.4.0 – 2026-11-03

- **Spec-driven instead of corporate roleplay.** The `product-owner`, `requirements-engineer` and `lead-dev`
  subagents are gone (Claude Code and OpenCode). The main session writes stories as a spec engineer with three
  lenses – domain, architecture, testability – instead of handing them to simulated roles. The `ux-designer` stays
  as an on-demand utility for `ui: true` stories and the prototyping phase; it never gates.
- **1-command rule.** One `type: domain` story = one command + its events on one aggregate, at most 4 Gherkin
  scenarios. `aggregate` and `command` are required frontmatter and are cross-checked against
  `docs/domain/events.yaml`; the events must be exactly what the command produces. `type: story` remains valid as a
  legacy alias and is reported as a warning.
- **Deterministic spec linter.** `node .claude/skills/user-stories/scripts/lint-story.ts [ST-NNN|file]` and
  `kataster lint-story` check frontmatter, required fields, referential integrity, `Given/When/Then`, the scenario
  limit and unique titles – no LLM, no tokens. The same rules run in the PostToolUse hook, `story-status.ts` and
  `verify.ts`. Green → `ready-for-human-review`; only the user approves `ready`.
- **Fast lane.** `type: chore` and `type: task` for UI tweaks, refactorings, dependencies and setup.
  `/implement --fast` (or automatic detection) does branch → implement → lint/typecheck/unit tests → pull request,
  without Gherkin matching or formal subagent reviews. `type: tech-task` and `type: spike` keep their behaviour.
- **Reviews report, they do not plan.** `code-reviewer` and `acceptance-tester` no longer create, split or revise
  stories; a finding is fixed in the story or handed back as an open question. Review effort follows the diff, not a
  T-shirt size. `size` is no longer a gate.
- **Installer prunes retired workflow files.** `upgrade` deletes the manifest-tracked files named in `OBSOLETE`
  (the removed agents). Locally modified files are kept and reported; `--force` backs them up first. Optional
  extras and user-added agents are never pruned.

## 0.3.1 – 2026-11-02

- **Optional prototyping, owned by the UX designer.** New `prototype` skill (adapted from Matt Pocock's, MIT) builds
  a throwaway self-contained HTML prototype for one design question: several structurally different UI variants
  (`ui`) or a clickable state model (`logic`). `/feature --prototype[=ui|logic]` – or a proposal from the UX frontier
  during grilling – runs it between grilling and the stories; `/implement --prototype` settles an open UI question
  before the test plan. The verdict goes into the story (`Prototype: …`) and, when it is a recurring rule, into
  `docs/product/ux-guidelines.md` as a G-number. The prototype lives under `docs/prototypes/<slug>/`, is captured on
  a throwaway branch `prototype/<slug>` and is never merged.
- **Credit where the workflow comes from.** `.claude/THIRD_PARTY_NOTICES.md` lists which skills are derived from
  [Matt Pocock's skills](https://github.com/mattpocock/skills) – some adapted, some copied verbatim – and carries his
  MIT license text. The file ships with the payload and lands in every installation; the README has a Credits
  section.

## 0.3.0 – 2026-10-31

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
