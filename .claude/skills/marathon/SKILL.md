---
name: marathon
description: Marathon run – the main session orchestrates story after story without the user: plans and claims the next ready story, starts a story-worker for it, runs the reviews, merges into an integration branch, verifies there and ends with one pull request for the whole run; `resume` goes on with a run that was cut off.
disable-model-invocation: true
argument-hint: "[resume] [--max-stories 6] [--max-failures 3] [--no-gate-foundation] [--budget-tokens <n>] [--budget-usd <n>]"
---

# Marathon

This session is the **orchestrator** of a run: it builds nothing itself. One story at a time it claims the story,
hands it to a **worker** (agent `story-worker`), reads the worker's report, runs the reviews, merges the story branch
into the run's **integration branch** and keeps the books. The run is serial – one claim, one worker.

The user is not there. One checkpoint is theirs: the **merge of the run's pull request** at the end. Whatever you
would ask on the way becomes an **escalation** – the story is set aside with its reason and the run goes on with the
next one. You write no application code and no tests, you repair no red verify and you decide no open domain or
technical question: all three end as an escalation or as the end of the run.

**The state.** `.claude/state/marathon.json` changes only through

```bash
node .claude/skills/marathon/scripts/marathon-state.ts <command>
```

Its exit code steers the run: `0` done · `1` refused – the message names what to fix first · `3` the run has to stop –
go to *End of the run*. Run each call as its own command and read what it prints: `NEXT`, `THEN` and `STOP` lines
are the next step, not a suggestion. `status` shows the run at any time.

**JSON for `--details`** goes into a file: write it with the file tool to `.kataster/details/ST-NNN-<step>.json`
(git-ignored) and pass `--details .kataster/details/ST-NNN-<step>.json`. A heredoc (`--details - <<'JSON'`) is
refused by Claude Code in `dontAsk` mode – the mode an unattended run uses.

**One session runs the run.** `start-run` and `resume` make this session the run's orchestrator; the hooks tell the
scripts who calls. A session that another one replaced – an orchestrator after a resume elsewhere, a worker after a
newer worker took its story – is refused by the scripts and blocked by the `marathon-guard` hook on every tool call.
That is the guard against two workers on one checkout; nothing has to be watched for it. While the run runs, nobody
schedules work for later (cron, automations): the guard blocks that too.

Arguments: `resume`, or a running run in `status` → *Resume*. Otherwise → *Setup*; the options go to `start-run`
unchanged.

## Setup

1. The working tree is clean, the default branch (`repo.defaultBranch` in `.claude/project.json`) is checked out and
   up to date (`git pull`). With a tracker (`backlog.provider` ≠ `local`) pull the mirror first (the `pull` of the
   `backlog` skill). Anything else: tell the user and stop – a run starts from a state they know.
2. Start the run:

   ```bash
   node .claude/skills/marathon/scripts/marathon-state.ts start-run [--max-stories <n>] [--max-failures <n>] [--no-gate-foundation] [--budget-tokens <n>] [--budget-usd <n>]
   ```

   It names the run after the day, cuts the integration branch `marathon/<date>` from the default branch and puts
   the checkout on it. Defaults: 6 stories, 3 failures in a row, foundation gate on, no budget. Refused → tell the
   user what it printed and stop.
3. Uncommitted files under `docs/stories/metrics/` came along: commit them as `metrics: collect`.
4. Tell the user in two lines what runs (run, branch, limits) – then start the loop without waiting for an answer.

## The loop – one story per round

### 1. Plan and claim

```bash
node .claude/skills/marathon/scripts/marathon-plan.ts
node .claude/skills/marathon/scripts/marathon-state.ts claim ST-NNN      # the story after NEXT
```

`STOP` in the plan, or exit 3 from `claim` → *End of the run*. The plan is the order; a different story is refused.

### 2. Start the worker

Start the agent `story-worker` with this task and wait for its last message (how, per harness: *Starting and
continuing a worker*):

```
/implement --worker ST-NNN --base <integration branch>
```

### 3. Read the report

The worker's last message is one JSON block (`"report": "implement-worker"`). Its `result` decides:

| `result` | What you do |
|---|---|
| `ready-for-review` | step 4 |
| `blocked` | `escalate` with the report's `reason` – then step 1 |
| `returned-to-review` | `escalate` with the reason and "story is back in `review` on `<branch>`" – then step 1 |
| no report, or a message that is not one | `result ST-NNN failed --reason "<what came back>"` – then step 1 |

```bash
node .claude/skills/marathon/scripts/marathon-state.ts escalate ST-NNN --reason "<reason>" --details .kataster/details/ST-NNN-escalate.json
```

The details file holds the worker's report block as it is (without the fence).

The report's open questions travel with it into the run's summary. After an escalation or a failed pass put the
checkout back on the integration branch (`git switch <integration branch>`); the story branch stays as it is, for
the user.

### 4. Reviews

The checkout is on the story branch, where the worker left it. The lanes are those of `/implement`: read *5. Review*
in `.claude/skills/implement/SKILL.md` once per run and pick the lane from the diff
(`git diff --name-only <integration branch>...HEAD`). Nobody is there to be offered a review, so a fast-lane diff
that touches authorization, input handling, a migration or security headers takes the normal lane; every other
fast-lane story goes straight to step 5.

Per reviewer:

1. `node .claude/skills/metrics/scripts/story-metrics.ts mark ST-NNN review-<agent> start`, right before you start it.
2. Start the reviewer with the story ID, the base ref (the integration branch), the context pack command and
   "Preview: none". Add: *tag every merge blocker `merge-blocker: <kind>` in its row – only a tagged one blocks the
   merge – and end your reply with the number of findings per severity – blocker, major, minor, question – and the
   number of merge blockers.* The acceptance tester counts a scenario without a real test, a failing test or a violated rule as
   blocker, a definition-of-done gap or a "fix now" edge case as major, a remark as minor.
3. `… mark ST-NNN review-<agent> end` once its review file is there. Read the file and **triage** its minors and
   questions (*Every finding is fixed in the story*, below), then record the review:

   ```bash
   node .claude/skills/marathon/scripts/marathon-state.ts review ST-NNN <agent> --verdict <verdict> --blocker <n> --major <n> --minor <n> --question <n> [--skip <n>]
   ```

   `--skip` counts the minors and questions of this review that get no fix pass – the two exceptions of the triage.

   The merge blockers are counted from the review file: the rows tagged `merge-blocker: <kind>`, nothing else. A
   `WARN` line names a finding that reads like one without the tag – it does not block; the summary lists it under
   *Possible merge blockers – please check*. You may put its fix into a worker's task like any finding.

   Verdicts: `accepted`, `accepted-with-remarks`, `not-accepted` (acceptance tester); `ready-to-merge`,
   `fix-blockers-first` (code reviewer). The same record goes into the story's metrics.

The review files are yours and the reviewers' to write, never the worker's. When every reviewer of the round is
recorded, commit `docs/reviews/` and `docs/stories/metrics/` on the story branch as `ST-NNN: review round <n>` and
follow the `NEXT` of the **last** `review` call:

- **`merge`** → step 5. Nothing is left for a worker: no finding, only skipped ones, or the fix pass for minors has
  run already.
- **`fixes`** → `marathon-state.ts claim ST-NNN --continue`, then continue the worker with the task from step 2 plus:
  *Continuation – fix the findings in `docs/reviews/ST-NNN-*.md`*, followed by **every** finding of the round that is
  not skipped – blockers, majors, minors and the questions you decided, each with its default named – and the
  skipped ones with their reason, so the worker leaves them alone. Read its report as in step 3. `ready-for-review` →
  what `THEN` said: the reviewers it names again (sub-steps 1–3, a new round), or step 5 – *the merge – no second
  review* after a pass for minors and decided questions alone. That pass is the story's only one: it is not reviewed
  again, and whatever a reviewer would still find is not a reason for another.

  **Every finding is fixed in the story** – the rule of step 6 in `/implement`. One fix pass gets all of them;
  there are two exceptions, and both are counted with `--skip`:

  | Finding | What you do |
  |---|---|
  | blocker, major | into the worker's task |
  | minor | into the worker's task – unless the reviewer itself marks it as not worth fixing (cosmetic, known debt): skipped, a `notes` line *minor skipped: <finding> – <the reviewer's reason>* |
  | question with a sensible conservative default (the reviewer's recommendation, the existing `invalid` path, *warn in QA, naming the field*) | **you decide it**: into the worker's task as a finding with the default named, and into `decisions` of step 5 with `"by": "orchestrator"` |
  | question that is a real product or domain decision, with no defensible default | skipped, an `openQuestions` entry (`kind: domain` or `product`); when the story cannot be built right without the answer, `escalate` instead |

  The worker never decides a question on its own and reports `blocked` for an undecided one – so it gets decided
  defaults, never raw questions. A technical question always has a default: `merge-check` refuses one left open.

  **A merge blocker is never a question, a decision or a skipped minor.** A finding tagged
  `merge-blocker: <kind>` (security and data protection, a 5xx answer to client input, an inconsistency that breaks
  a domain rule) goes into the worker's task as a finding to fix, whatever severity the reviewer gave it, with the
  conservative fix named. The reviewer who found it runs again after the fix pass; reports one again → `escalate`.
- **`escalate`** → the story was `not accepted` twice, or a merge blocker survived its fix pass: `escalate` with what
  remains as the reason, back to the integration branch, step 1.

**You never create a story** – not from a finding, a question or anything else the reviews leave. A finding is fixed
in its story or is an open question for the user. A gap in the feature's story split – behaviour no story of the
feature covers – is an `openQuestions` entry with the suggestion to widen a story of the same feature that is not
built yet; never a new story.

### 5. Integrate

Every sub-step is safe to repeat; after a resume skip what is already done.

1. Write the details file of sub-step 6 now and check it before anything is merged:
   `node .claude/skills/marathon/scripts/marathon-state.ts merge-check ST-NNN --details .kataster/details/ST-NNN-merged.json`.
   Refused → nothing is merged; it names what to do: a tagged merge blocker or a round's findings without their
   fix pass → back to step 4 **`fixes`**; a skipped minor without its reason or an open technical question → fix the
   details file (a technical question gets its default and goes to `fixes`). `POSSIBLE` lines do not refuse – they go
   into the summary for the user.
   Then `… story-metrics.ts mark ST-NNN integration start`, `git switch <integration branch>`,
   `git merge --no-ff <story branch> -m "Merge ST-NNN: <title>"`.
2. `mark ST-NNN verify start`, `node .claude/skills/implement/scripts/verify.ts` (with `--e2e` when browser tests
   exist), `mark ST-NNN verify end`.
   **Red → the run stops here.** `marathon-state.ts result ST-NNN failed --reason "verify red on <integration branch> after the merge: <failed steps>"`,
   `mark ST-NNN integration end`, then *End of the run*. The merge stays as it is.
3. `node .claude/skills/implement/scripts/story-status.ts ST-NNN done`. With a tracker this is where it follows
   (GitHub closes the issue; for Jira run the transition the script prints). Refused → `escalate` with what it
   printed.
4. From the worker's reports: every `newTerms` entry into `CONTEXT.md` (the format of the `domain-model` skill),
   every `adrProposals` entry as a `proposed` ADR (the format of the `architect` skill). You alone give out ADR
   numbers: the highest number in `docs/adr/` plus one, one after the other.
5. `node .claude/skills/user-stories/scripts/render-backlog.ts`, `node .claude/skills/adopt/scripts/repo-map.ts`
   (the merge may have added files or packages; it rewrites `docs/architecture/repo-map.*` and the generated block
   in `AGENTS.md` – bookkeeping, like the backlog), `mark ST-NNN integration end`,
   `node .claude/skills/metrics/scripts/story-metrics.ts collect`, then commit everything as `ST-NNN: done`.
6. Record the merge – it is checked against git, the verify run, the reviews (a `domain`, `tech-task` or `spike`
   story needs an accepting `acceptance-tester`; only `chore` and `task` are fast) and the repository map. The
   details file `.kataster/details/ST-NNN-merged.json` holds **this story's** notes, questions and decisions only –
   never those of a story that was escalated before it. A merge blocker is none of them: the gate refuses a
   decision or an open question tagged `merge-blocker: <kind>`, and an open merge blocker in a reviewer's last
   review – go back to `fixes` (`claim ST-NNN --continue`) instead:

   ```json
   { "notes": ["<ADR 0007 proposed: …>", "<new term: …>", "<minor skipped: <finding> – <the reviewer's reason>>"],
     "openQuestions": [{ "question": "<a product or domain decision only the user can make, with the options>", "kind": "domain|product" }],
     "decisions": [<the worker report's decisions, as they are>,
                   { "question": "<the reviewer's question>", "decision": "<the default you handed the worker>", "why": "<the reviewer's recommendation, why it is conservative>", "by": "orchestrator" }] }
   ```

   The summary lists only what needs the user: the open questions and the possible merge blockers. Decisions stay in
   their own section, one line each; notes stay with their story.

   ```bash
   node .claude/skills/marathon/scripts/marathon-state.ts result ST-NNN merged --details .kataster/details/ST-NNN-merged.json
   ```

Then step 1.

## End of the run

The run ends when the plan or `claim` says `STOP` – nothing left to plan, a limit or the budget reached, the
foundation gate, a red verify on the integration branch – or when the user ends it.

1. `node .claude/skills/marathon/scripts/marathon-state.ts finish` (the reason is the `STOP` reason; when the user
   ended the run: `--reason "<why>"`).
2. Run the `collect --since …` command `finish` printed: it adds what the run's sessions spent outside a phase –
   this session is still open, so the hooks have not collected it yet. Commit what it wrote as `metrics: collect`.
   Then `node .claude/skills/marathon/scripts/marathon-state.ts summary --out .claude/state/marathon-pr.md` – the
   summary, the escalations with their reasons, the open questions that need the user, the possible merge blockers,
   the decisions taken with a default (by a worker or by you) and the metrics of every story of the run.
3. `git push -u origin <integration branch>` and open the pull request to the default branch: title
   `Marathon <run>: <n> stories`, body = that file (`gh pr create --base <default branch> --body-file …`; as
   `--draft` when the run ended on a red verify). Without `gh`: the compare URL `git push` prints.
4. `node .claude/skills/marathon/scripts/marathon-state.ts finish --pr <url>`. With a tracker, push the mirror once
   (the `push` of the `backlog` skill) – the tracker is synced from here only, never by a worker.
5. Tell the user: the pull request, what was merged, what was escalated, the decisions taken with a default, what
   they have to decide, and – when `finish` printed `CHECK` – a section *Possible merge blockers – please check* with
   every entry of that summary section, and the run's tokens and cost (the `**Run:**` line of the summary). **The user merges.**

## Resume

A run that was cut off – a closed session, a crash, the other harness – goes on from its state:

```bash
node .claude/skills/marathon/scripts/marathon-state.ts resume
```

A claim without a running worker is **orphaned**. A worker is running only when this very session started it and
still waits for its report – then pass `--running ST-NNN`. `resume` makes this session the orchestrator: the session
that ran the run before and the worker of every continued claim are superseded (`SUPERSEDED` lines) and can do
nothing any more, even when they still run in the background. Per line:

| Line | What you do |
|---|---|
| `CHECKOUT` with uncommitted paths on a story branch | a pass was cut off mid-work: commit them there as `ST-NNN: wip pass cut off` |
| `CHECKOUT` with uncommitted paths on the integration branch | step 5 was cut off: go on with it |
| `REPORT ST-NNN` | the pass ended and handed in its report, but nobody read it: read the file it names and go on with step 3 – no new pass |
| `CONTINUE ST-NNN` | step 2 with a fresh `story-worker` and the task plus *Continuation – an earlier pass was cut off*; the pass is counted already, as a pass after a cut-off – not as a failure |
| `SUPERSEDED …` | nothing – that session is blocked from here on |
| `MERGE ST-NNN` | step 5 |
| `RELEASED ST-NNN` | nothing – the story is back in the plan |
| `NEXT` / `STOP` | step 1 / *End of the run* |
| finished, no pull request | *End of the run* from sub-step 2 |

In OpenCode a session outlives its terminal: the background service keeps running it. You do not have to find out
whether an earlier worker is alive – once you resumed, it is superseded and the guard blocks its next tool call.

## Starting and continuing a worker

The task text is the same in both harnesses; the branch is the worker's memory, so a fresh worker can always go on.

| | Claude Code | OpenCode |
|---|---|---|
| Start | `Agent` tool, `subagent_type: story-worker`, the task as `prompt` | `subagent` tool, `agent: story-worker`, the task as `prompt` |
| The report | the agent's last message, when it completes | the call returns a `sessionID` at once; the report arrives as a `<background-result kind="subagent">` message – end your turn and wait for it |
| Continue with findings | `SendMessage` to that agent – same session, its context intact | `subagent` again with that `sessionID` |
| When that worker is out of reach (resumed run, other harness, the ID is lost) | a fresh `story-worker` with the same task | a fresh `story-worker` with the same task |

Reviewers are started the same way, each fresh.
