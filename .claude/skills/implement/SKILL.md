---
name: implement
description: Engineering workflow – implements one story from docs/stories/ on its own branch, verifies, reviews scaled to the diff, refactors and hands the pull request to the user; `type: chore`/`task` (or `--fast`) takes the fast lane without Gherkin matching or formal reviews; `--prototype` settles an open UI question first; `--worker ST-NNN --base <branch>` builds one given story for an orchestrator up to a green verify and returns a report instead of asking.
disable-model-invocation: true
argument-hint: "[ST-NNN – empty = next ready story] [--fast] [--prototype[=ui|logic]] | --worker ST-NNN --base <branch>"
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

`--worker ST-NNN --base <branch>` makes this session the **worker** of an orchestrator instead of the user's main
session: read *Worker mode* at the end of this file before anything else. It replaces steps 1.1, 1.2, 1b, 5, 7 and 8
and every question to the user. Without `--worker`, nothing in that section applies.

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

**Metrics.** Mark each step with `node .claude/skills/metrics/scripts/story-metrics.ts mark ST-NNN <phase> start|end`,
each marker as its own command (the `metrics` skill explains it; the hooks add who you are). Phases: `kontext`
(1.3–1.4), `testplan` (2),
`characterization` (2a), `implementierung` (3), `verify` (4), `review-<agent>` per reviewer (5), `fixes` (6),
`merge` (7, from the pull request to the user's merge). A marathon orchestrator marks `integration` instead of `merge`. A skipped step gets no marker; both lanes mark the steps they
run. Commit `docs/stories/metrics/` with the step's commit – never edit those files.

## 1. Prepare
1. Working tree clean, on the default branch (`repo.defaultBranch`), up to date (`git pull`). Otherwise stop and tell
   the user. Changes only under `docs/stories/metrics/` (metrics an earlier session collected) do not count: commit
   them on the story branch as `metrics: collect` before `ST-NNN: start`.
2. With a tracker (`backlog.provider` ≠ `local`), pull first (`/backlog-sync pull`) and check that the story has its
   `external` key – an unlinked story never reaches `ready`, so stop and report instead of implementing a stale mirror.
3. Mark `kontext start`, then `node .claude/skills/implement/scripts/story-context.ts ST-NNN` – the context pack:
   story, exact test titles, dependencies, events/commands/rules/invariants, glossary, data model, ADRs, research
   sources. Read it completely;
   it is your source, not memory. When a scenario depends on a cited finding, read the research file listed under
   `## Research sources` – findings are evidence, not a specification. If an aggregate in the pack has
   `status: unresolved`, stop: the consistency boundary is not settled, so the story goes back to `review` instead
   of being decided in code.
4. `git switch -c st-NNN-<slug>` (slug from the file name), then
   `node .claude/skills/implement/scripts/story-status.ts ST-NNN in-progress`, mark `kontext end` and commit
   `ST-NNN: start`.
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

Mark `testplan start` before and `testplan end` after the plan.

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

## 2a. Characterization net (domain lane, existing behaviour)

Before the first red test, find out whether the affected paths already have a net (mark `characterization start`
before the check, `characterization end` after the last characterization commit):

```bash
node .claude/skills/implement/scripts/characterize.ts --story ST-NNN
# or name the paths directly
node .claude/skills/implement/scripts/characterize.ts --changed <file>
```

The check names the affected source files, the tests it found and the files with **no test found**. It is a
test-presence check, not a coverage tool: whether a test covers the behaviour that is about to change is your
judgement.

For every affected path whose behaviour is about to change and has no test:

1. Write a **characterization test** that pins the current behaviour (Feathers): assert what the code does today,
   not what the story wants it to do.
2. Run it on the unchanged code and see it green. A red characterization test is not the story's red step.
3. Commit it separately: `ST-NNN: characterize <area>`.
4. Only then start the story's red → green loop (step 3).

If the current behaviour contradicts the story, that is a **finding**, not a test to adjust: mark the story `[OPEN]`,
add a row to `docs/stories/OPEN_QUESTIONS.md`, and send it back with
`node .claude/skills/implement/scripts/story-status.ts ST-NNN review`. Do not silently make the code fit the story.

If the repository has no test runner, stop and report it: setting one up is its own `task` story, not a side effect
of this one.

**Fast lane:** skip this step. The exception is a refactoring – when the task says behaviour stays unchanged (or the
story carries the label `refactor`), write the characterization net first; a refactor without one is a rewrite.

## 3. Red → green (domain) / implement (fast)

Mark `implementierung start` before the first test or change, `implementierung end` after the last green commit.

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
Mark `verify start`, run `node .claude/skills/implement/scripts/verify.ts` (with `--e2e` when browser tests exist)
until it is green, mark `verify end`. It must be green: lint incl.
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

Mark `review-<agent> start` right before you start each reviewer (`review-code-reviewer`,
`review-acceptance-tester`; started together, both run at once) and `review-<agent> end` once its review file is
there. A second round is a second pass. Then record each review – verdict and findings per severity – with
`node .claude/skills/metrics/scripts/story-metrics.ts review ST-NNN <agent> --verdict <verdict> --blocker <n> --major <n> --minor <n> --question <n>`.

Both reviewers report findings and never create stories. A finding is **fixed in this story** or becomes an open
question to the developer (step 6) – there is no follow-up ticket.

Say which lane you picked and why in one line.

## 6. Refactor
Mark `fixes start` before the first fix and `fixes end` after the last green run of this step.
- Fix all blockers and majors **inside this story**, and the minors you agree with; say which minors you skip and why.
  A finding tagged `merge-blocker: <kind>` (security, privacy, authorization, injection, server-error, rule-bypass)
  is never skipped and never handed back as a question, whatever severity it carries.
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
4. Mark `merge start` once the pull request is open. **The user merges** – on the preview if they want to look
   first. When they say it is merged: back to the default branch, `git pull`, mark `merge end` (the waiting time is
   the gate; its entry is committed with the next story's `metrics: collect`).

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
decision open – and when a characterization test shows that the current behaviour differs from what the story
assumes:
1. Stop implementing that part. Mark it `[OPEN]` in the story and add a row to `docs/stories/OPEN_QUESTIONS.md`.
2. `node .claude/skills/implement/scripts/story-status.ts ST-NNN review` and tell the user. The fix goes through
   discovery in the main session: revise the story, run the spec linter, and let the user approve it again
   (`/review-stories`). Work already done on the branch stays.
3. New domain term → `CONTEXT.md` (domain-model skill). Architecture deviation → a `proposed` ADR (architect skill).
   An accepted ADR's decision is never changed in place; the hooks block it (editorial fixes need an
   `## Editorial changes` entry).
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
  time-based rule (and the time zone "today" is taken in), UI texts, test data builders and the fixed clock, **input
  and errors** (a request body that is not the expected shape, how text input is normalised before it is checked and
  stored, which limits exist), and the **seam catalog** – which seam each kind of code is tested at. The user
  approves it; then re-check the stories that depend on the foundation's results. What the conventions leave open,
  a worker decides with a default (*Worker mode*) – the fewer such decisions, the fewer to confirm afterwards.

## Worker mode (`--worker ST-NNN --base <branch>`)

An orchestrator – a marathon run – started this session for exactly one story. The worker builds it on the story
branch up to a green verify and ends with a **report**; it has no user. The cut is the same in Claude Code and
OpenCode:

| | Worker (this session) | Orchestrator |
|---|---|---|
| Story, base | given by the arguments; the base is used as it is in the checkout | picks the story, owns the base, pulls |
| Tracker | untouched: every `story-status.ts` call carries `--no-tracker` | syncs it – `done` after the merge, the push at the end |
| Steps | 1.3–1.5, 2, 2a, 3, 4 – on a continuation also 6 | 5 (reviews), 7 (`done`, push, pull request, merge), 8 |
| Questions | become the report | talks to the user |
| `CONTEXT.md`, `docs/adr/`, `docs/reviews/` | reads; proposes in the report | writes |
| Subagents | none | starts the reviewers on the worker's branch |

The worker runs everything itself, in this one session: reviewers, `ux-designer` and every other subagent, task or
child session belong to the orchestrator – in both harnesses alike, also where the harness would let a worker start
one. `--fast` works as in the manual mode. `--prototype` is a user's verdict: report `blocked`.

### W1. Start the pass

```bash
node .claude/skills/implement/scripts/worker.ts start ST-NNN --base <branch>
```

This is the worker's whole preparation in place of steps 1.1, 1.2 and the `git switch` of 1.4: it checks that the
base exists, the tree is clean and the story is `ready` on the base and linked to the tracker, then puts the checkout
on the story branch. The story is the given one and the base is taken as it is – `next-story.ts`, `git pull`,
`git fetch` and `/backlog-sync pull` are the orchestrator's.

- `STOP` → nothing was switched: report `blocked` with those lines as the reason (W3).
- `PASS first` → the branch is new, cut from the base. Go on with step 1.3, then 1.4 without its `git switch`
  (`story-status.ts ST-NNN in-progress --no-tracker`), 1.5, 2, 2a, 3 and 4.
- `PASS continuation` → the branch exists: review findings came back, a decision you were blocked on was made, or an
  earlier pass was cut off. **The branch is the memory**, not this session: run step 1.3 again (`kontext start`,
  the context pack, `kontext end`), read `git log <base>..HEAD`, the files listed under `REVIEWS` and whatever the
  task adds (findings, the decision).
  Then, in the same branch:
  - **Findings** → step 6 with its markers (`fixes start` … `fixes end`): fix blockers and majors and the minors you
    agree with, each in its own commit. Every finding goes into the report's `findings` as `fixed`, `skipped` (say
    why in the text) or `open`. A finding without a recommended option, or too large for this story, is `open` and
    gets an `openQuestions` entry – the pass ends `blocked`.
  - **Unfinished work** (a `wip` commit, a scenario without its commit, a story still `ready`) → continue at the
    first step that is not done.
  - Then step 4 again, with its own `verify` markers.

`METRICS` in the output: commit those files as `metrics: collect` before anything else, as step 1.1 says.

### W2. Build – the same steps, the same markers

Steps 1.3 to 4 run as written above, lane by lane, with the same phase markers (`kontext`, `testplan`,
`characterization`, `implementierung`, `verify`; `fixes` on a continuation). Step 4 is the worker's only gate: the
quick gate at the end of a turn runs for a main session, not for a worker that is a subagent or child session.

Wherever a step says *stop*, *ask* or *tell the user*, the pass ends with a report instead:

| What happened | Result |
|---|---|
| *When the story is wrong* applies: a contradiction with another story, a rule or an ADR; a scenario that cannot be tested as written; a decision the story leaves open; an `unresolved` aggregate; a characterization test that contradicts the story; a chore that turns out to be domain behaviour | Do steps 1–2 of that section on the branch (`[OPEN]`, the `OPEN_QUESTIONS.md` row, `story-status.ts ST-NNN review --no-tracker`), commit `ST-NNN: back to review` → `returned-to-review` |
| The story is fine, but something it does not own is missing: a seam that is not in the catalog, a decision no ADR or convention covers, a term you would have to invent, a test runner, a spike's timebox, a tool or environment that fails, a verify that stays red after honest attempts, an `open` finding | `blocked` |
| Every scenario (domain) is built and every checklist item of the story is ticked (`- [x]`, the last one too – the orchestrator only sets `done`), and step 4 is green | `ready-for-review` |

**`blocked` is a result of equal rank.** An open domain decision is never made in code: when the outcome of a
scenario depends on a value or rule nobody stated (how long a loan runs), when two rules contradict, or when an
invariant could be read two ways, stop that part and report the question with its options. A precise `blocked`
report is a good pass; a guessed implementation is a failed one, however green it is.

**A technical detail is decided with a default – not blocked.** The story, `events.yaml`, `CONTEXT.md`, the ADRs and
the conventions will not name every technical detail. Decide it yourself, and record it in the report's `decisions`
(`question`, `decision`, `why`), when **all** of these hold:

1. It is about *how*, not about *what the domain does*: the status and body of an error the story does not name (a
   body that is not JSON), parsing and encoding, the time zone of the system clock, names of helpers and files, the
   layout of tests, an extra test the scenarios do not ask for.
2. The default is the conservative one: it rejects rather than accepts, adds no business rule, and stores domain
   data as the story describes it – no trimming, rounding or limit the story does not ask for.
3. It follows the conventions and the code that exists (*use the existing `invalid` path*), not a new pattern.
4. It is cheap to change later: local to this story, no migration, no published contract.

**The absence of a rule is not a question.** Do not invent a length limit, a fee or a normalisation the story does
not state, and do not block because there is none – build what the story says; a gap worth grilling goes into
`decisions` as *"no limit – the story names none"*. When one of the four conditions fails, it is a decision for
somebody else: `blocked`, with the question and its options.

**A merge blocker is neither a default nor a question.** Security and data protection (personal data exposed in a
response, a log or an error; a command or query without its authorization check; untrusted input that reaches a
query, a shell or HTML unescaped), a 5xx answer to anything a client can send (malformed JSON, `null`, a missing
field, a wrong type), and an inconsistency that breaks a domain rule (a uniqueness or invariant that case, spaces or
normalisation get around) are fixed in this pass, with a test that pins the fix – never put into `decisions`, never
`skipped`. The fix is the conservative one: reject rather than accept, the existing `invalid` path, compare the
normalised copy. Only when the fix itself needs a decision the story does not own is the pass `blocked`, with the
blocker named in the reason. Reviewers tag them `merge-blocker: <kind>`, and only a tag blocks: `worker.ts report`
refuses a decision or a skipped finding that carries one, and the orchestrator merges none. A decision or skipped
finding that merely reads like one is a `⚠` warning (`lib/merge-blockers.ts`) – look again: if it is a merge
blocker, fix it; otherwise leave it, the run's summary lists it for the user to check.

The repository map (`repo-map.ts`, the advisory step in `verify.ts`) and its block in `AGENTS.md` are the
orchestrator's: a stale map is not yours to regenerate.

**Proposals instead of edits.** A domain word the story uses and `CONTEXT.md` lacks goes into `newTerms`; a decision
that deserves an ADR goes into `adrProposals`. When the code depends on a word or decision that nobody approved yet,
it is an `openQuestions` entry as well, and the pass is `blocked`.

**Every pass ends committed, on the story branch.** Close the phase you are in (`… end`), then commit: green work
under its normal message, anything unfinished as `ST-NNN: wip <what is missing>`, `docs/stories/metrics/` after the
last marker as `ST-NNN: metrics`. The story stays `in-progress` (or `review` when it went back); `done`, the push and
the pull request are the orchestrator's.

### W3. Report

Write your part with the file tool to `.kataster/details/ST-NNN-report.json` (git-ignored) – a heredoc is refused
by Claude Code in `dontAsk` mode, the mode an unattended run uses:

```json
{
  "reason": "<why this result, in one or two sentences – for ready-for-review: what a reviewer should know, e.g. a fast-lane diff that touches authorization>",
  "findings":      [{ "finding": "<the finding>", "action": "fixed|skipped|open" }],
  "newTerms":      [{ "term": "<word>", "meaning": "<what it means here>" }],
  "adrProposals":  [{ "title": "<decision>", "why": "<what depends on it, the options>" }],
  "decisions":     [{ "question": "<the technical detail that was open>", "decision": "<the default you built>", "why": "<the convention or code it follows, why it is safe>" }],
  "openQuestions": [{ "question": "<what has to be decided, with the options>", "kind": "domain|technical" }]
}
```

```bash
node .claude/skills/implement/scripts/worker.ts report ST-NNN --base <branch> --result <result> --details .kataster/details/ST-NNN-report.json
```

You pass your judgement; the script reads the rest from git and the last `verify.ts` run – branch, head, commits,
changed files, uncommitted paths, the verify result – and prints the report as one JSON block. Empty lists may be
left out. It refuses a result the facts contradict (exit 1): `ready-for-review` needs the story `in-progress`, a
clean tree, a green verify on the branch head, nothing that would stop `done` after the merge (a scenario without
its test, an unticked checklist item) and no open question or finding; `returned-to-review` needs the story
in `review` and its open question; `blocked` needs only its reason. `decisions` never block. Fix what it names, or
report `blocked`. A decision or a skipped finding tagged `merge-blocker: <kind>` is refused as well – fix it.

In a marathon run the script also keeps the report for the run (`.claude/state/marathon-reports/`), so an
orchestrator that was cut off reads it instead of starting another pass – and it refuses a worker the run has
replaced. A `LEASE … replaces` line from `start`, or a tool call blocked by `marathon-guard`, means another worker
builds this story now: stop, without a report.

**Your last message is that JSON block, verbatim, and nothing after it.** The orchestrator parses it; it starts the
reviews, and a later continuation brings their findings back to W1.
