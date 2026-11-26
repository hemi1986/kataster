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
   "Preview: none". Add: *end your reply with the number of findings per severity – blocker, major, minor,
   question.* The acceptance tester counts a scenario without a real test, a failing test or a violated rule as
   blocker, a definition-of-done gap or a "fix now" edge case as major, a remark as minor.
3. `… mark ST-NNN review-<agent> end` once its review file is there, then record the review:

   ```bash
   node .claude/skills/marathon/scripts/marathon-state.ts review ST-NNN <agent> --verdict <verdict> --blocker <n> --major <n> --minor <n> --question <n>
   ```

   Verdicts: `accepted`, `accepted-with-remarks`, `not-accepted` (acceptance tester); `ready-to-merge`,
   `fix-blockers-first` (code reviewer). The same record goes into the story's metrics.

The review files are yours and the reviewers' to write, never the worker's. When every reviewer of the round is
recorded, commit `docs/reviews/` and `docs/stories/metrics/` on the story branch as `ST-NNN: review round <n>` and
follow the `NEXT` of the **last** `review` call:

- **`merge`** → step 5. Minors and questions alone start no worker pass: put the ones that matter into the
  `notes` and `openQuestions` of step 5.
- **`fixes`** → `marathon-state.ts claim ST-NNN --continue`, then continue the worker with the task from step 2 plus:
  *Continuation – fix the findings in `docs/reviews/ST-NNN-*.md`*, the minors you want fixed as well, and the ones
  to skip. Read its report as in step 3. `ready-for-review` → what `THEN` said: the acceptance tester again (sub-steps
  1–3, a new round) or step 5.

  **Reviewer questions never go into a worker's task.** A question (severity `question`) is not a finding to fix:
  it travels with you into the `openQuestions` of step 5 – a worker that is handed one has to report `blocked`, and
  the story is lost for a question that blocks nothing. For a finding that needs a technical choice, name the
  default you want (*use the existing `invalid` path, 422*) instead of asking the worker to decide or to block.
- **`escalate`** → the story was `not accepted` twice: `escalate` with the gaps that remain as the reason, back to
  the integration branch, step 1.

### 5. Integrate

Every sub-step is safe to repeat; after a resume skip what is already done.

1. `… story-metrics.ts mark ST-NNN integration start`, `git switch <integration branch>`,
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
   never those of a story that was escalated before it:

   ```json
   { "notes": ["<ADR 0007 proposed: …>", "<new term: …>", "<minor skipped: … – why>"],
     "openQuestions": [{ "question": "<a reviewer's question the user has to answer>", "kind": "domain|technical" }],
     "decisions": [<the worker report's decisions, as they are>] }
   ```

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
   summary, the escalations with their reasons, the open questions, the decisions taken with a default and the
   metrics of every story of the run.
3. `git push -u origin <integration branch>` and open the pull request to the default branch: title
   `Marathon <run>: <n> stories`, body = that file (`gh pr create --base <default branch> --body-file …`; as
   `--draft` when the run ended on a red verify). Without `gh`: the compare URL `git push` prints.
4. `node .claude/skills/marathon/scripts/marathon-state.ts finish --pr <url>`. With a tracker, push the mirror once
   (the `push` of the `backlog` skill) – the tracker is synced from here only, never by a worker.
5. Tell the user: the pull request, what was merged, what was escalated, the decisions taken with a default, what
   they have to decide, and the run's tokens and cost (the `**Run:**` line of the summary). **The user merges.**

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
