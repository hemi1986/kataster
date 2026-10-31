---
name: implement
description: Engineering workflow – implements one story from docs/stories/ test-first on its own branch, verifies, has it reviewed by code-reviewer and acceptance-tester, refactors, and sets it `done` on the acceptance tester's verdict and hands the pull request to the user to merge.
disable-model-invocation: true
argument-hint: "[ST-NNN – empty = next ready story]"
---

# Implement a Story

Story: the arguments from the invocation (empty → `node .claude/skills/implement/scripts/next-story.ts`; a story already `in-progress` is finished first).

The main session writes the code; subagents only review. One checkpoint belongs to the user: the **merge** (step 7). Everything before it runs without asking – a `ready` story is good enough to build up to the pull request, and the acceptance tester accepts the story, not the user – unless the story turns out to be wrong (see *When the story is wrong*) or a seam is missing from the catalog (step 2).

Engineering conventions: `docs/engineering/conventions.md` – read it if it exists; it describes the module layout, how commands and read models are built, and the **seam catalog**.

Project profile: `.claude/project.json` – default branch, code roots, commands, preview provider, pull-request tool. Read it instead of assuming `main`, `npm` or GitHub.

## 1. Prepare
1. Working tree clean, on the default branch (`repo.defaultBranch`), up to date (`git pull`). Otherwise stop and tell the user.
2. With a tracker (`backlog.provider` ≠ `local`), pull first (`/backlog-sync pull`) and check that the story has its
   `external` key – an unlinked story never reaches `ready`, so stop and report instead of implementing a stale mirror.
3. `node .claude/skills/implement/scripts/story-context.ts ST-NNN` – the context pack: story, exact test titles, dependencies, events/commands/rules/invariants, glossary, data model, ADRs. Read it completely; it is your source, not memory.
4. `git switch -c st-NNN-<slug>` (slug from the file name), then `node .claude/skills/implement/scripts/story-status.ts ST-NNN in-progress` and commit `ST-NNN: start`.

## 2. Test plan
Call the `skill` tool for `tdd` (and `codebase-design` when a new module or interface is involved).
Show one table and go on to step 3 without waiting:

| Scenario (exact test title) | Seam | Test type | Test file |
|---|---|---|---|

- **Story**: one row per Gherkin scenario. **Tech task**: one row per checklist item that can be tested; the rest gets its evidence named (setting, document). **Spike**: no table – see *Spikes*.
- Seams come from the seam catalog in the engineering conventions. A seam not in the catalog is a decision for the user – the one case where you stop here and ask.
- Name anything the story leaves open. Don't guess – see *When the story is wrong*.

Seams from the catalog are the "confirmed seams" the tdd skill requires; the user approved the catalog.

## 3. Red → green, one scenario at a time
- Per row: write the test (title exactly `ST-NNN: <scenario title>`), run it and see it fail for the right reason, write the minimal code to pass, run it green. Commit: `ST-NNN: <scenario title>`.
- Domain IDs in the code: commands, events, read models and policies carry their ID from `events.yaml` (`CMD-ReportProblem`, `EVT-ProblemReported`, …). New code uses the words of `CONTEXT.md`; a new term goes into `CONTEXT.md` first (domain-model skill).
- Never weaken or delete an existing test to get green. If a test from an earlier story blocks you, its story and this one contradict each other → *When the story is wrong*.
- Hooks help on the way: formatting and lint after every write, the quick gate (type check + related tests) before you finish a turn.
- In a monorepo, run the affected set for the packages you touched before the full gate:
  `node .claude/skills/implement/scripts/affected.ts --changed <files>` (or `--base <defaultBranch>`), then
  execute the printed command. It follows shared-library dependents; `verify.ts` still runs everything at the end.

## 4. Verify
`node .claude/skills/implement/scripts/verify.ts` (with `--e2e` when browser tests exist) must be green: lint incl. module boundaries, type check, tests, events and stories valid, scenario ↔ test and domain ID traceability. Language warnings: fix or justify.

The full `--e2e` run happens **once, before the push**. During red → green run only the spec you are working on; after the refactor (step 6) run `verify.ts` without `--e2e` plus the specs the refactor touched – CI runs every browser test on the pull request anyway (check `e2e`).

## 5. Review (in parallel, scaled to the story)
Push the branch (`git push -u origin st-NNN-<slug>`) so a preview deployment exists, when the project has one
(`review.preview` in `.claude/project.json`: `vercel`, `netlify`, … – use the provider's MCP or CLI, or the pull
request's preview comment). Otherwise there is no preview and the reviewers work from the code.

Pick the lane first – review effort follows the risk of the diff, not a fixed list:

**Light lane** – when **all** of these hold: size **S**, `events: []`, no command, no migration, no input handling
(no request handler, form action or route added or changed), no new dependency. Typical: static pages, texts, a
link, layout.
- Only `acceptance-tester` – task: story ID, base ref, the preview URL (if known), and: *also check the diff briefly against the engineering conventions (texts from the catalogs, the shared page frames, domain language) and list deviations as minors.* Writes `docs/reviews/ST-NNN-acceptance.md`.
- No `code-reviewer`, no extra code or security pass.

**Normal lane** – everything else. Start in **one** message:
- `code-reviewer` – task: story ID, base ref, the context pack command. Writes `docs/reviews/ST-NNN-code-review.md`.
- `acceptance-tester` – task: story ID, base ref, the preview URL (if known). Writes `docs/reviews/ST-NNN-acceptance.md`.
- Only for size **L/XL** or a story that changes the command layer or other shared platform code: ask the `code-reviewer` for a second, bug-focused pass over the diff.
- Only when the **diff** touches input handling, login/roles/session, uploads or files, or security headers/CSP: ask the `code-reviewer` for a security-focused pass.

Say which lane you picked and why in one line.

Tell the reviewers the follow-up hurdle below, so they grade findings with it in mind.

## 6. Refactor
- Fix all blockers and majors **inside this story**, and the minors you agree with; say which minors you skip and why. Where a finding offers options, apply the recommended one without asking; ask only when no option is recommended or a follow-up story is at stake.
- **Follow-up hurdle** – a finding becomes a new story only if all of these hold:
  1. it is a security or data-loss risk, or it blocks a *named* upcoming story;
  2. it cannot be fixed in this story within about an hour;
  3. no existing story can take it (check the stories that will first touch that code – prefer adding a checklist item there, via `requirements-engineer`, over a new story).
  Otherwise it stays a line in the review file ("skipped minor" or "revisit when …") – no story. Say for each follow-up why it passes the hurdle.
- Follow-ups that pass: delegate to `requirements-engineer` as new tech-task stories (`status: draft`, label `follow-up`), referencing the review file. They go through `/review-stories` like any story.
- **Foundation just in time**: technical groundwork goes into the first story that needs it, not into a separate tech task ahead of the domain stories – a `must` tech task with met dependencies jumps ahead of every domain story in the backlog order.
- Refactor only with green tests; the tests must not change unless they were wrong (then say so). Run
  `affected.ts` for the touched packages, then `node .claude/skills/implement/scripts/verify.ts` again (without
  `--e2e`) plus the browser specs the refactor touched – see step 4.

## 7. Acceptance and merge → user checkpoint
The **acceptance tester's verdict is the acceptance**: the story is `done` in the pull request, so the user only merges.
1. After the refactor, check the verdict in `docs/reviews/ST-NNN-acceptance.md`. `accepted` or `accepted with remarks` → continue. `not accepted` → fix the gaps in the story and run the `acceptance-tester` again, until it accepts. Only when something goes badly wrong – the verdict stays `not accepted` after a second round, a scenario can't be met as written, the preview shows a defect the tester couldn't see – ask the user, the way *When the story is wrong* describes.
2. `node .claude/skills/implement/scripts/story-status.ts ST-NNN done` – refuses unless every scenario has its test (story) or every checklist item is ticked (spike/tech task) and all dependencies are done. Commit `ST-NNN: done`, push.
   - GitHub: the status change closes the linked issue.
   - Jira: `story-status.ts` prints the transition it could not make (MCP is agent-only). Run `jira_get_transitions` +
     `jira_transition_issue` on the printed key, then push the story body once (`/backlog-sync push`).
3. Open a pull request: title `ST-NNN: <story title>`, body = the scenarios as a checklist, links to the story and both review files, the acceptance verdict, the preview URL, remaining minors, and anything the user must approve (a conventions change). (No `gh` CLI, or it isn't authenticated: push and give the user the compare URL `git push` prints.)
4. **The user merges** – on the preview if they want to look first. Afterwards: back to the default branch and `git pull`.

## 8. Wrap-up
Summarize in a few lines: scenarios implemented, review findings fixed/skipped, follow-ups created, glossary/ADR changes. Then:
- Suggest `/improve-codebase-architecture` after the foundation stories, when a bounded context is complete, or about every 8–10 done stories.
- Name the next story (`node .claude/skills/implement/scripts/next-story.ts`) and tell the user to start it in a fresh session (`/new`, then `/implement`): every turn re-reads the whole session, so a second story in the same one costs several times the first.

## Spikes
A spike answers its **Question** within its **Timebox** – no test plan, no TDD for throwaway experiments.
- Before starting, tell the user the timebox and what will be kept (skeleton code that becomes the application gets tests and passes verify).
- Tick each checklist item in the story file as it is answered; write results where the item says (an ADR's consequences, `OPEN_QUESTIONS.md`). A new decision → ADR with `status: proposed` (architect skill); the user accepts.
- Timebox exhausted → stop, document what is known, and ask the user how to continue.
- Review: `code-reviewer` only for code that is kept; `acceptance-tester` checks the checklist evidence.

## When the story is wrong
Never guess. When a scenario contradicts another story, a rule or an ADR, can't be tested as written, or leaves a decision open:
1. Stop implementing that part. Mark it `[OPEN]` in the story and add a row to `docs/stories/OPEN_QUESTIONS.md`.
2. `node .claude/skills/implement/scripts/story-status.ts ST-NNN review` and tell the user. The fix goes through discovery: `requirements-engineer` revises the story, `/review-stories` approves it again. Work already done on the branch stays.
3. New domain term → `CONTEXT.md` (domain-model skill). Architecture deviation → a `proposed` ADR (architect skill). An accepted ADR is never edited; the hooks block it.
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
