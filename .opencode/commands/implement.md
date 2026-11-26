---
description: Engineering workflow – implements one story from docs/stories/ on its own branch, verifies, reviews scaled to the diff, refactors and hands the pull request to the user; `type: chore`/`task` (or `--fast`) takes the fast lane without Gherkin matching or formal reviews; `--prototype` settles an open UI question first; `--worker ST-NNN --base <branch>` builds one given story for an orchestrator up to a green verify and returns a report instead of asking.
---

Load the `implement` skill with the `skill` tool and follow it exactly. Do not restate it.

When the arguments contain `--worker`, this session is a worker: the skill's *Worker mode* section applies, with
`--worker <ST-ID>` and `--base <branch>` taken from the arguments unchanged. A worker runs in this one session – it
starts no subagent (no reviewer either, even though this harness could start one), asks no question and ends with
the JSON report as its last message. An orchestrator starts it as the `story-worker` agent, whose permissions enforce
the same.

Arguments: $ARGUMENTS
