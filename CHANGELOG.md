# Changelog

## Unreleased

- **Merge blockers.** Security and data protection (personal data exposed, a missing authorization check,
  injection), a 5xx answer to client input and an inconsistency that breaks a domain rule (a uniqueness that
  normalisation gets around) never pass as *decided with a default* or as an open question. `lib/merge-blockers.ts`
  names the six kinds and recognises them in text. `worker.ts report` refuses a decision or a skipped finding that
  names one; the reviewers file them as blockers tagged `merge-blocker: <kind>`, and `marathon-state.ts review`
  counts the tags in the review file (`--merge-blocker <n>` for the rest). A merge blocker sends the story into a fix
  pass with the reviewer who found it again; reported again after that, the story is escalated. The merge gate and
  the new read-only `merge-check` (run before `git merge`) refuse an open one in a reviewer's last review and one
  disguised as a decision or an open question in the merge's details.
- **Upgrade keeps comments in `opencode.jsonc`.** The installer edited the file by parsing and re-serialising it, so
  every comment and the project's formatting were lost on upgrade. It now edits the text in place
  (`src/jsonc.mjs`, no dependency): missing keys, rules and watcher globs are inserted at the end of their object or
  list, in the indentation and one-line style of their neighbours; everything else stays byte for byte, and an
  upgrade with nothing to add leaves the file unchanged.
- **OpenCode automations off by default.** `.opencode/opencode.jsonc` ships `"automations": false`; init and upgrade
  add it where the project did not set the key (a project's own value is kept). Why: in the marathon test run an
  agent whose shell commands were denied searched the Code Mode tools for another way, and `automation.create` would
  have run a shell command later – outside the session's permission rules and the Kataster hooks. `marathon-guard.ts`
  still blocks creating one during a run for projects that turn them back on.
- **Marathon: one session at a time, enforced.** A real run left two orchestrators and two workers on one checkout
  (OpenCode runs sessions in its background service, a closed TUI stops nothing). The run now has a lease
  (`.claude/state/marathon-lease.json`, `lib/lease.ts`): `start-run`/`resume` make the calling session the
  orchestrator, `worker.ts start` the calling worker the holder of its story; the hooks append `--caller` to
  `worker.ts` and `marathon-state.ts` calls (`hooks/metrics.ts`). A replaced session is refused by the scripts and
  blocked on every tool call by the new `marathon-guard.ts` hook in both harnesses; `resume` supersedes the worker of
  a continued claim at once. The `git status` heuristic in the skill is gone. Scheduling work for later (Claude Code's
  cron/triggers/wakeups, OpenCode automations, also from a Code Mode script) is blocked while a run runs.
- **Marathon: a report is never lost.** `worker.ts report` keeps the report of a claimed story
  (`.claude/state/marathon-reports/ST-NNN.json`); `resume` prints `REPORT` and reads it instead of starting another
  pass when the branch head is unchanged. A pass after a cut-off is counted as `resumed` and shown as such in the
  summary – it is no failure.
- **Decided with a default.** Worker reports carry `decisions` (`question`, `decision`, `why`) for technical details
  the story and the conventions leave open; they do not block `ready-for-review`. The implement skill states when a
  worker decides (technical, conservative, following the conventions, cheap to change) and that a missing rule is no
  question; domain gaps stay `blocked`. `result … merged` takes them, the summary lists them under *Decided with a
  default – confirm or change*. Reviewer questions no longer go into a worker's task.
- **Merge gate.** `result … merged` refuses a `domain`, `tech-task` or `spike` story without an accepting
  `acceptance-tester` review, and a stale repository map; the skill runs `repo-map.ts` after each merge (`AGENTS.md`
  counts as bookkeeping for the generated block).
- **Metrics before the pull request.** `story-metrics.ts collect --since <ISO time>` finalises every session with a
  marker since then, idle or not; `finish` prints it with the run's start, so the pull request's metrics include the
  tokens spent outside a phase (in OpenCode they were missing until the next session start).
- **No heredocs in the skills.** Claude Code refuses a heredoc in `dontAsk` mode; `--details` JSON is written to
  `.kataster/details/` and passed as a file.
- **Input and errors.** The conventions template, the conventions skill and the foundation guidance ask how a
  malformed request is answered, how text is normalised, which limits exist and in which time zone "today" is taken;
  `/feature` grills validation, limits, normalisation and error behaviour per command.

- **Story metrics.** `story-metrics.ts mark <ST-NNN|feature:<slug>> <phase> start|end` marks a phase; `/shape`,
  `/feature`, `/review-stories` and `/implement` mark theirs. Tokens (input, output incl. reasoning, cache
  read/write), model, harness, agent time and user wait time land append-only in `docs/stories/metrics/`, one entry
  per pass, stream and model; tokens outside every phase go to an `unassigned` pot. Two adapters read the usage:
  Claude Code transcripts (with `subagents/`) and the OpenCode database (read-only, `node:sqlite`, child sessions,
  legacy-table fallback, schema check). A PreToolUse hook / the plugin adds the caller's session and subagent id to
  the marker; `PermissionRequest`, OpenCode's `permission.*`/`form.*` events and `SessionStart`/`SessionEnd` complete
  waits and finalise sessions. `story-metrics.ts report [--story|--feature|--since] [--json]` prices tokens from
  `metrics.prices` in `.claude/project.json` (no built-in prices), splits a feature's spec cost across its stories
  by scenarios/checklist items, and compares `size` with the actual cost.
- **`feature` in the story frontmatter.** `feature: <slug>` links a story to the `/feature` run that derived it; the
  linter refuses a mismatch with the `feature:<slug>` label and more than one feature label, and warns about a label
  without the field.
- **`/implement` tolerates collected metrics.** Uncommitted files under `docs/stories/metrics/` no longer block the
  clean-tree check; they are committed as `metrics: collect` on the story branch.
- **Marathon run.** `/marathon` makes the main session the orchestrator of an unattended run, serial for now. Setup
  cuts the integration branch `marathon/<date>` from the default branch and starts the run with its limits: stories
  per run (default 6), failures in a row (default 3), the foundation gate (on by default, `--no-gate-foundation`) and
  an optional budget (`--budget-tokens`, `--budget-usd`) read from the story metrics. Per story the orchestrator
  plans and claims, starts the `story-worker` with `/implement --worker ST-NNN --base marathon/<date>` and reads its
  report: `blocked` and `returned-to-review` are escalated with their reason and the run goes on, `ready-for-review`
  starts the reviewers in the lanes of `/implement` with `review-<agent>` markers. Findings go back to the worker –
  the same agent session where the harness can continue one, otherwise a fresh worker on the same branch; the second
  `not accepted` escalates the story. An accepted story is merged into the integration branch, `verify.ts` runs
  there, the story is set `done`, the report's new terms and ADR proposals are written (the orchestrator alone gives
  out ADR numbers), `BACKLOG.md` is rendered and the metrics are collected. The run stops when nothing is left to
  plan, a limit or the budget is reached, the foundation tasks (`type: tech-task`) are merged and another story is
  next, or `verify.ts` is red on the integration branch – then at once, and nothing is repaired. It ends with a push
  and one pull request to the default branch (a draft after a red verify): summary, escalations with their reasons,
  open questions and the metrics of the run's stories. The user merges.
  - `node .claude/skills/marathon/scripts/marathon-state.ts` is the only writer of `.claude/state/marathon.json`:
    `start-run`, `claim [--continue]`, `review`, `result merged|failed`, `escalate`, `release`, `resume`, `finish`;
    `status` and `summary` read. Every write holds a lock file and replaces the state atomically (temp file +
    rename) after validating it. A stale lock – its process is gone, or it is older than a minute – is broken with a
    warning; a live one is waited for and then refused. A broken state file is an error for every command and is
    never overwritten, and `protect-files.ts` blocks hand edits. Exit 3 means the run has to stop.
  - `result ST-NNN merged` is checked against the facts: the story branch is in the integration branch, the last
    `verify.ts` run is green, was on the integration branch and covers the merge, only docs and the glossary changed
    since, and the story is `done`. A second failed pass of a story escalates it.
  - **Resume.** `/marathon resume` (`marathon-state.ts resume`) goes on with a run that was cut off, also from the
    other harness. A claim without a running worker is orphaned: with its story branch a worker continues on it and
    the pass counts as an attempt; without the branch the claim is released; a story that is accepted or merged
    already goes on with the merge step.
  - **Both harnesses.** One skill (`.claude/skills/marathon/SKILL.md`); `.opencode/commands/marathon.md` only loads
    it. Starting and continuing a worker is the one harness difference, documented in the skill: Claude Code uses
    the `Agent` tool (`subagent_type: story-worker`) and `SendMessage`; OpenCode uses the `subagent` tool
    (`agent: story-worker`), which returns a `sessionID` at once and delivers the report as a background result –
    the same tool with that `sessionID` continues the worker (checked against OpenCode 2.4.1). The scripts are
    covered by the existing allow rule for `.claude/skills/marathon/scripts/*` in `.claude/settings.json`,
    `.opencode/opencode.jsonc` and the installer.
  - The decisions are pure functions in `lib/marathon.ts` (`stopReason`, `reviewNext`, `orphanAction`,
    `mergeErrors`, `nextStep`, `renderSummary`), tested without a repository or an agent.
- **Marathon planner.** `node .claude/skills/marathon/scripts/marathon-plan.ts [--n <workers>] [--json]` plans the
  next wave of a marathon run: `ready` stories in backlog order whose `depends_on` are all `done`, that no worker has
  claimed, that the run did not escalate and has not merged yet. A `failed` story may run again and keeps its
  attempt count. The run state is read from `.claude/state/marathon.json`, at the same path for both harnesses; the
  planner never writes it, and a broken file is an error rather than an empty state. When the run has to stop, the
  wave is empty and `STOP` says why. `--n` is the worker count, and only 1 is accepted until conflict keys exist.
  The logic is `planWave()` in `lib/engineering.ts`, next to `nextStory()`.
- **Reviews in the story metrics.** `story-metrics.ts review ST-NNN <agent> --verdict <verdict> --blocker <n> --major <n> --minor <n> --question <n>`
  records one review – who reviewed, the verdict, the findings per severity – next to the story's entries;
  `report --story` shows them, `--json` carries them. `/implement` records its reviews this way, a marathon run
  through `marathon-state.ts review`. New phase `integration` for the orchestrator's merge step.
- **A worker cannot report `ready-for-review` for a story that could not be set `done`.** `worker.ts report` now
  also refuses when a scenario has no test or a checklist item is unticked – the orchestrator sets `done` after the
  merge and must not find out there. A worker ticks every checklist item, the last one too, and changes the story
  status with `--no-tracker`: the tracker is synced by the orchestrator only.
- **The quick gate waits for the worker.** `stop-gate.ts` does nothing while a marathon run holds a claim: the
  uncommitted code is a worker's, and the session that ends its turn is the orchestrator waiting for it. The session
  start names an unfinished run.
- **Worker mode for `/implement`.** `/implement --worker ST-NNN --base <branch>` builds one given story for an
  orchestrator: no auto-pick and no `git pull`, the story branch is cut from `--base` in the normal checkout, then
  context pack, test plan, characterization, red → green and `verify.ts` run as in the manual mode, with the same
  phase markers. The worker starts no reviews and ends after verify. Instead of asking the user it returns a JSON
  report: `result` (`ready-for-review` | `blocked` | `returned-to-review`), `reason`, branch, commits, changed files,
  the verify result, review findings and what became of them, new terms, ADR proposals and open questions. `blocked`
  is a result of equal rank: an open domain or technical decision is reported, never decided in code. A worker is
  resumable – when the story branch exists, the pass is a continuation that reads the branch and the review files,
  fixes the findings in the same branch and reports again. The manual mode is unchanged.
  - `node .claude/skills/implement/scripts/worker.ts start|report` are the mechanical ends of a pass. `start` checks
    the base, the tree and the story's status on the base and creates or switches to the story branch. `report`
    reads branch, commits, changed files and the verify result from git and the last `verify.ts` run, and refuses a
    result the facts contradict – `ready-for-review` needs a clean tree, a green verify on the branch head and no
    open question.
  - New agent `story-worker` in both harnesses, the same instructions in each. That a worker starts no subagent is
    enforced, not only written down: `disallowedTools: Agent` in Claude Code – where subagents may otherwise nest
    three levels deep – and `subagent: deny` in OpenCode. Both also block questions and writes to `CONTEXT.md`,
    `docs/adr/` and `docs/reviews/`; `path-guard.ts` learned `--deny` for that.
  - Hooks in a worker: the tool hooks (protect-files, bash-guard, metrics identity, validate-docs, code-check,
    project checks) run for subagents and child sessions in both harnesses. The quick gate at the end of a turn does
    not – Claude Code fires `Stop` for the main session only, the OpenCode plugin skips child sessions – and that is
    kept on purpose: the worker's gate is `verify.ts`, and a message after its last turn would produce a second
    report.
- **The quick gate no longer loses the first changed file.** `stop-gate.ts`, `characterize.ts` and `affected.ts`
  trimmed the output of `git status --porcelain` before cutting off the status columns, which shifted the path of an
  unstaged file: the Stop gate skipped the first modified file (and ran nothing when it was the only one), and
  `affected.ts` lost every unstaged modification. All three now use `changedPaths()` in `lib/git.ts`
  (`--porcelain -z`).
- **`verify.ts` ignores collected metrics when it records `dirty`.** Uncommitted files under `docs/stories/metrics/`
  no longer mark the verified code as changed, in line with the clean-tree check of `/implement`.
- **OpenCode mirrors Claude Code's permissions.** Every entry of Claude Code's allow list becomes a `shell` rule in
  `.opencode/opencode.jsonc` with the same pattern: the workflow scripts, `git status/diff/log`, `gh issue/label`.
  A project that puts `shell` behind `ask` is no longer prompted for them. On upgrade the installer appends the
  missing rules after the project's own, since OpenCode applies the last matching rule, and recognises a rule
  regardless of key order. A `permissions` value that is not a rule list is left alone.

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
