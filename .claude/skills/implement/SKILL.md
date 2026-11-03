---
name: implement
description: Engineering workflow – implements one story from docs/stories/ on its own branch, verifies, reviews scaled to the diff, refactors and hands the pull request to the user; `type: chore`/`task` (or `--fast`) takes the fast lane without Gherkin matching or formal reviews; `--prototype` settles an open UI question first.
disable-model-invocation: true
argument-hint: "[ST-NNN – empty = next ready story] [--fast] [--prototype[=ui|logic]]"
---

# Implement a Story

Story: the arguments from the invocation (empty → `node .claude/skills/implement/scripts/next-story.ts`; a story
already `in-progress` is finished first). `--fast` and `--prototype[=ui|logic]` are flags, not the story ID: strip
them before resolving the story.

The main session writes the code; subagents only review, and only in the full domain lane. One checkpoint belongs to
the user: the **merge** (step 7). Everything before it runs without asking – a `ready` story is good enough to build
up to the pull request, and the acceptance tester accepts the story, not the user – unless the story turns out to be
wrong (see *When the story is wrong*), a seam is missing from the catalog (step 2), or the user asked for a prototype
(step 1b – the verdict is theirs).

## Two lanes

| Lane | Stories | What changes |
|---|---|---|
| **Domain** (default) | `type: domain` (legacy `story`) | TDD per Gherkin scenario, scenario ↔ test traceability, diff-scaled review, acceptance tester's verdict |
| **Fast** | `type: chore`, `type: task`, or `--fast` on such a story | branch → implement → lint/typecheck/unit tests → verify → PR; no Gherkin matching, no formal review pass, the user merges |

`--fast` on a `type: domain` story is ignored: the story has a command and scenarios, so it takes the domain lane.
If a "chore" turns out to touch a command, a migration or authorization, stop and say so – risk decides the lane,
not the label.

Engineering conventions: `docs/engineering/conventions.md` – read it if it exists; it describes the module layout,
how commands and read models are built, and the **seam catalog**.

Project profile: `.claude/project.json` – default branch, code roots, commands, preview provider, pull-request tool.
Read it instead of assuming `main`, `npm` or GitHub.

## 1. Prepare
1. Working tree clean, on the default branch (`repo.defaultBranch`), up to date (`git pull`). Otherwise stop and tell
   the user.
2. With a tracker (`backlog.provider` ≠ `local`), pull first (`/backlog-sync pull`) and check that the story has its
   `external` key – an unlinked story never reaches `ready`, so stop and report instead of implementing a stale mirror.
3. `node .claude/skills/implement/scripts/story-context.ts ST-NNN` – the context pack: story, exact test titles,
   dependencies, events/commands/rules/invariants, glossary, data model, ADRs. Read it completely; it is your
   source, not memory.
4. `git switch -c st-NNN-<slug>` (slug from the file name), then
   `node .claude/skills/implement/scripts/story-status.ts ST-NNN in-progress` and commit `ST-NNN: start`.
5. **Pick the lane** and say it in one line: fast lane for `chore`/`task`, domain lane otherwise. The fast lane is
   a shortcut for non-domain work, never a way to skip a risk review.

## 1b. Prototype (only when asked)

Only with `--prototype`, or when the user explicitly asks during the story. A `ui: true` story whose screen shape is
still open was not `ready`; this is the exception that settles it before the test plan. Load the `prototype` skill and
follow it.

1. **Standalone first.** Delegate to `ux-designer`: question, branch (`ui` or `logic`), variants/scenarios, timebox,
   target `docs/prototypes/<slug>/`. It writes the self-contained HTML file. The user decides.
2. **In-app only when the question needs the real page** – an existing route, real data, the real header and
   sidebar. You build the throwaway route or the `?variant=` gate yourself, following the project's routing
   convention; the `ux-designer` defines the question and variants and reviews the result. The prototype stays out of
   the production path and is captured on `prototype/<slug>`.
3. **Capture.** Commit `docs/prototypes/<slug>/` (or the in-app prototype) on `prototype/<slug>`, return to the story
   branch, and write the verdict into the story's `## Context`: `Prototype: prototype/<slug> – <question> – <verdict>`.
   A recurring rule goes to `ux-designer` for `docs/product/ux-guidelines.md`.
4. **Then decide.** If the prototype only settles layout and the scenarios still hold, continue with step 2. If it
   changes behaviour or a scenario, the story goes back to `review` (see *When the story is wrong*), the main session
   revises it, the spec linter runs and the user approves it again. The branch stays.

## 2. Test plan

**Domain lane.** Call the `skill` tool for `tdd` (and `codebase-design` when a new module or interface is involved).
Show one table and go on to step 3 without waiting:

| Scenario (exact test title) | Seam | Test type | Test file |
|---|---|---|---|

- One row per Gherkin scenario – at most 4 by the 1-command rule.
- Seams come from the seam catalog in the engineering conventions. A seam not in the catalog is a decision for the
  user – the one case where you stop here and ask.
- Name anything the story leaves open. Don't guess – see *When the story is wrong*.

Seams from the catalog are the "confirmed seams" the tdd skill requires; the user approved the catalog.

**Fast lane.** No scenario table. Name the files or packages you will touch and the unit/integration tests that
cover them; the story's checklist is the acceptance. If it already has scenarios, keep them as a sanity check but do
not create `ST-NNN:` test titles.

## 3. Red → green (domain) / implement (fast)

**Domain lane:**
- Per row: write the test (title exactly `ST-NNN: <scenario title>`), run it and see it fail for the right reason,
  write the minimal code to pass, run it green. Commit: `ST-NNN: <scenario title>`.
- Domain IDs in the code: commands, events, read models and policies carry their ID from `events.yaml`
  (`CMD-ReportProblem`, `EVT-ProblemReported`, …). New code uses the words of `CONTEXT.md`; a new term goes into
  `CONTEXT.md` first (domain-model skill).
- Never weaken or delete an existing test to get green. If a test from an earlier story blocks you, its story and
  this one contradict each other → *When the story is wrong*.

**Fast lane:**
- Implement the task, keep the change as small as the checklist says, and add or update unit tests where the change
  can break behaviour. No test-title matching, no scenario traceability.
- Tick each checklist item in the story file as it becomes true (`- [x] …`).
- If the work turns into domain behaviour (a new/changed command, event or invariant), stop: the story is the wrong
  type. Send it back to `review` as a `domain` story instead of deciding it in code.

**Both lanes** – hooks help on the way: formatting and lint after every write, the quick gate (type check + related
tests) before you finish a turn. In a monorepo, run the affected set for the packages you touched before the full
gate: `node .claude/skills/implement/scripts/affected.ts --changed <files>` (or `--base <defaultBranch>`), then
execute the printed command. It follows shared-library dependents; `verify.ts` still runs everything at the end.

## 4. Verify
`node .claude/skills/implement/scripts/verify.ts` (with `--e2e` when browser tests exist) must be green: lint incl.
module boundaries, type check, tests, events and stories valid, scenario ↔ test and domain ID traceability. Language
warnings: fix or justify.

The full `--e2e` run happens **once, before the push**. During red → green run only the spec you are working on;
after the refactor (step 6) run `verify.ts` without `--e2e` plus the specs the refactor touched – CI runs every
browser test on the pull request anyway (check `e2e`).

## 5. Review (domain lane only, scaled to the diff)

**Fast lane: skip this step.** No `code-reviewer`, no `acceptance-tester`, no review file. The gate is step 4 plus
the user's merge. If the diff touches authorization, input handling, a migration or security headers, say so and offer
the normal review anyway – the lane follows the risk, not the label.

**Domain lane.** Push the branch (`git push -u origin st-NNN-<slug>`) so a preview deployment exists, when the project
has one (`review.preview` in `.claude/project.json`: `vercel`, `netlify`, … – use the provider's MCP or CLI, or the
pull request's preview comment). Otherwise there is no preview and the reviewers work from the code.

Pick the lane from the **diff**, not from a size label:

**Light lane** – all of these hold: the diff is texts, layout, styles, links or docs; no command or route added or
changed; no input handling (no request handler, form action); no migration; no new dependency.
- Only `acceptance-tester` – task: story ID, base ref, the preview URL (if known), and: *also check the diff briefly
  against the engineering conventions (texts from the catalogs, the shared page frames, domain language) and list
  deviations as minors.* Writes `docs/reviews/ST-NNN-acceptance.md`.
- No `code-reviewer`, no extra code or security pass.

**Normal lane** – everything else. Start in **one** message:
- `code-reviewer` – task: story ID, base ref, the context pack command. Writes `docs/reviews/ST-NNN-code-review.md`.
- `acceptance-tester` – task: story ID, base ref, the preview URL (if known). Writes `docs/reviews/ST-NNN-acceptance.md`.
- Only when the **diff** touches the command layer or other shared platform code: ask the `code-reviewer` for a
  second, bug-focused pass over the diff.
- Only when the **diff** touches input handling, login/roles/session, uploads or files, or security headers/CSP: ask
  the `code-reviewer` for a security-focused pass.

Both reviewers report findings and never create stories. A finding is **fixed in this story** or becomes an open
question to the developer (step 6) – there is no follow-up ticket.

Say which lane you picked and why in one line.

## 6. Refactor
- Fix all blockers and majors **inside this story**, and the minors you agree with; say which minors you skip and why.
  Where a finding offers options, apply the recommended one without asking; ask only when no option is recommended.
- **No follow-up stories from reviews.** A finding that is too large for this story is either:
  1. a **question to the developer** in the review file and in the wrap-up (with evidence and options), or
  2. a line in `## Out of Scope` / a row in `OPEN_QUESTIONS.md` when it is a real decision for the user.
  Only the main session and the user decide whether it becomes a new story; the reviewers never do.
- Refactor only with green tests; the tests must not change unless they were wrong (then say so). Run `affected.ts`
  for the touched packages, then `node .claude/skills/implement/scripts/verify.ts` again (without `--e2e`) plus the
  browser specs the refactor touched – see step 4.

## 7. Done, acceptance and merge → user checkpoint

**Fast lane:** tick the last checklist item, then
`node .claude/skills/implement/scripts/story-status.ts ST-NNN done` (it refuses while a checklist item is open).
Commit `ST-NNN: done`, push, open the pull request.

**Domain lane:** the **acceptance tester's verdict is the acceptance**: the story is `done` in the pull request, so
the user only merges.
1. After the refactor, check the verdict in `docs/reviews/ST-NNN-acceptance.md`. `accepted` or `accepted with
   remarks` → continue. `not accepted` → fix the gaps in the story and run the `acceptance-tester` again, until it
   accepts. Only when something goes badly wrong – the verdict stays `not accepted` after a second round, a scenario
   can't be met as written, the preview shows a defect the tester couldn't see – ask the user, the way *When the story
   is wrong* describes.
2. `node .claude/skills/implement/scripts/story-status.ts ST-NNN done` – refuses unless every scenario has its test
   (domain) or every checklist item is ticked (chore/task/tech task/spike) and all dependencies are done. Commit
   `ST-NNN: done`, push.
   - GitHub: the status change closes the linked issue.
   - Jira: `story-status.ts` prints the transition it could not make (MCP is agent-only). Run
     `jira_get_transitions` + `jira_transition_issue` on the printed key, then push the story body once
     (`/backlog-sync push`).

**Both lanes – the pull request:**
3. Title `ST-NNN: <story title>`, body = the scenarios as a checklist (domain) or the task checklist (fast lane),
   links to the story and the review files (if any), the acceptance verdict (domain), the preview URL, remaining
   minors/questions, and anything the user must approve (a conventions change). (No `gh` CLI, or it isn't
   authenticated: push and give the user the compare URL `git push` prints.)
4. **The user merges** – on the preview if they want to look first. Afterwards: back to the default branch and
   `git pull`.

## 8. Wrap-up
Summarize in a few lines: lane taken, scenarios implemented or task completed, review findings fixed/skipped, open
questions handed to the developer, glossary/ADR changes. Then:
- Suggest `/improve-codebase-architecture` after the foundation stories, when a bounded context is complete, or about
  every 8–10 done stories.
- Name the next story (`node .claude/skills/implement/scripts/next-story.ts`) and tell the user to start it in a fresh
  session (`/new`, then `/implement`): every turn re-reads the whole session, so a second story in the same one costs
  several times the first.

## Spikes
A spike answers its **Question** within its **Timebox** – no test plan, no TDD for throwaway experiments.
- A UX or state-model spike is a prototype: load the `prototype` skill, keep the question and timebox in the story,
  and capture the verdict the same way (step 1b).
- Before starting, tell the user the timebox and what will be kept (skeleton code that becomes the application gets
  tests and passes verify).
- Tick each checklist item in the story file as it is answered; write results where the item says (an ADR's
  consequences, `OPEN_QUESTIONS.md`). A new decision → ADR with `status: proposed` (architect skill); the user accepts.
- Timebox exhausted → stop, document what is known, and ask the user how to continue.
- Review: `code-reviewer` only for code that is kept; `acceptance-tester` checks the checklist evidence.

## When the story is wrong
Never guess. When a scenario contradicts another story, a rule or an ADR, can't be tested as written, or leaves a
decision open:
1. Stop implementing that part. Mark it `[OPEN]` in the story and add a row to `docs/stories/OPEN_QUESTIONS.md`.
2. `node .claude/skills/implement/scripts/story-status.ts ST-NNN review` and tell the user. The fix goes through
   discovery in the main session: revise the story, run the spec linter, and let the user approve it again
   (`/review-stories`). Work already done on the branch stays.
3. New domain term → `CONTEXT.md` (domain-model skill). Architecture deviation → a `proposed` ADR (architect skill).
   An accepted ADR is never edited; the hooks block it.
4. A `done` story is never reopened – a change to finished behaviour is a new story.

## Foundation stories
The first stories build what all others rely on, so they also set up the workflow's tooling:
- A single quality command in the repository's task runner (e.g. `npm run verify`) that runs
  `node .claude/skills/implement/scripts/verify.ts`. CI runs the same command.
- Scripts for `lint` (including module-boundary rules), `typecheck`, `test` and, when there are browser tests,
  `test:e2e`. Record them under `commands` in `.claude/project.json` – verify and the hooks read them there.
- The application's lint and type-check configs exclude `.claude/` and `docs/`; the tooling has its own tsconfig.
- The hooks use Prettier, ESLint, `tsc` and Vitest when they are installed in the app's `node_modules`. With a
  different toolchain, adapt `.claude/hooks/stop-gate.ts` and `code-check.ts` – they are plain Node.
- **After the foundation exists** write `docs/engineering/conventions.md` from what now exists (not before):
  module layout, how a command runs (transaction, journal, authorization, version check), a read model, a
  time-based rule, UI texts, test data builders and the fixed clock, and the **seam catalog** – which seam each
  kind of code is tested at. The user approves it; then re-check the stories that depend on the foundation's results.
