---
name: metrics
description: Story metrics – phase markers (`story-metrics.ts mark`), where tokens, cost and time per story come from in Claude Code and OpenCode, how feature-level spec cost is split across stories, and the report (`story-metrics.ts report`). Use when a workflow skill tells you to mark a phase, or when the user asks what a story or feature cost.
---

# Story Metrics

Every workflow skill marks its phases. The marker is the only thing you do; tokens, cost and time are collected
from the harness, so the numbers do not depend on what you remember.

```bash
node .claude/skills/metrics/scripts/story-metrics.ts mark <ST-NNN|feature:<slug>> <phase> start|end
```

- **Run it as its own command**, exactly in this form. The PreToolUse hook (Claude Code) or the plugin (OpenCode)
  appends who you are (`--harness`, `--session`, `--agent`, `--transcript`) – never pass those flags yourself.
- `start` when the step begins, `end` when it is finished. A step you skip gets no marker. A phase that runs twice
  (verify after a fix, a second review round) is marked twice – each start → end is one *pass*.
- A failing marker never blocks the workflow: it prints a warning and the session hooks collect later. Do not retry
  or work around it.
- Never edit `docs/stories/metrics/*.json` – they are append-only and the hooks block hand edits. Commit them with
  the work they describe.

## Phases and targets

| Skill | Target | Phases |
|---|---|---|
| `/shape` | `feature:<slug>` | `shape` |
| `/feature` | `feature:<slug>` | `grilling`, `event-storming`, `domain-architect`, `story-writing` |
| `/review-stories` | `feature:<slug>` when the stories share a feature, otherwise each `ST-NNN` | `review-stories` |
| `/implement` | `ST-NNN` | `kontext`, `testplan`, `characterization`, `implementierung`, `verify`, `review-<agent>` (one per reviewer, e.g. `review-code-reviewer`), `fixes`, `merge` |
| `/marathon` (orchestrator) | `ST-NNN` | `review-<agent>`, `integration` (merge into the integration branch up to `done`), `verify` inside it; the worker marks the `/implement` phases |

Spec work happens before story ids exist, so it is marked on the feature. Every story the feature derives carries
`feature: <slug>` in its frontmatter (and the `feature:<slug>` label) – that link is how the report shares the
feature's cost.

## Reviews

Whoever starts a reviewer records the outcome once its review file is there – the verdict and the findings per
severity:

```bash
node .claude/skills/metrics/scripts/story-metrics.ts review ST-NNN <agent> --verdict <verdict> --blocker <n> --major <n> --minor <n> --question <n>
```

Verdicts: `accepted`, `accepted-with-remarks`, `not-accepted` (acceptance tester), `ready-to-merge`,
`fix-blockers-first` (code reviewer). The record lands in the story's metrics file next to its entries and shows in
`report --story`. In a marathon run `marathon-state.ts review` writes the same record – use that one there.

## What is measured

- **Tokens** per entry, normalised so nothing is counted twice: `input` (uncached), `output` (including
  reasoning/thinking), `reasoning` (the part of `output` that was thinking – informational), `cacheRead`,
  `cacheWrite` (all TTLs) and `cacheWrite1h` (its 1-hour part, Claude only). One API response is counted once
  (deduplicated by message id).
- **Time**: `agentMs` (working) and `userWaitMs` (waiting for the user – an open question, a permission prompt, the
  gap between the end of a turn and the next prompt, a gate such as `merge`).
- **Who**: one entry per pass, stream (main session or subagent / child session) and model, with `harness`
  (`claude-code` | `opencode`), `model` and `provider`. Subagents without markers of their own count towards the
  phase that was open in their parent – `review-<agent>` goes to the reviewer of that type.
- **Unassigned**: tokens and time outside every phase go to the phase `unassigned` of the target that was marked
  last (or into `unassigned.json` when the session marked nothing). It is written when the session ends, and shows
  in the report – a large pot means a step is missing its marker.
- **Not stored**: the cost. Entries keep raw tokens and the harness's own figure (`harnessCostUsd`, OpenCode only);
  the report prices the tokens.

## Prices

`.claude/project.json` – USD per million tokens, per model (`<model>` or `<provider>/<model>`). There are no
built-in prices: a model without one shows `–` as cost and is listed as a warning.

```jsonc
"metrics": {
  "prices": {
    "<model>":            { "input": <usd>, "output": <usd>, "cacheRead": <usd>, "cacheWrite": <usd>, "cacheWrite1h": <usd> },
    "<provider>/<model>": { "input": <usd>, "output": <usd>, "cacheRead": <usd>, "cacheWrite": <usd> }
  }
}
```

`input` and `output` are required; a cache price is needed as soon as the model used that cache class.
`cacheWrite1h` falls back to `cacheWrite`. Reasoning is billed as output and is already in `output`.

## Spec cost per story

The report splits each feature's entries across the stories with `feature: <slug>` (superseded ones excluded).
**Key:** weight = number of Gherkin scenarios (domain stories) or acceptance checklist items (chore, task, tech
task, spike). When every story has a weight, the split is proportional; otherwise it is equal. The split is
computed in the report only – the feature's entries stay raw, so the key can change without rewriting history.

## The report

```bash
node .claude/skills/metrics/scripts/story-metrics.ts report                       # stories, features, size vs. actual
node .claude/skills/metrics/scripts/story-metrics.ts report --story ST-012        # phases of one story
node .claude/skills/metrics/scripts/story-metrics.ts report --feature order-photos # spec cost and its split
node .claude/skills/metrics/scripts/story-metrics.ts report --since 2026-11-01 --json
```

`collect` finalises sessions by hand (`--session <id>`, or every idle one); the session hooks normally do it.

## Where the data comes from

| | Claude Code | OpenCode |
|---|---|---|
| Usage | transcript JSONL (`transcript_path`), subagents in `<session>/subagents/agent-*.jsonl` + `.meta.json` | SQLite `opencode.db` (read-only): `session_v2`, `session_message`, child sessions via `parent_id`; legacy `session`/`message` as fallback |
| Who marked | PreToolUse hook: `session_id`, `agent_id`, `agent_type`, `transcript_path` | plugin `execute.before`: session id (a child session is a subagent), agent name |
| Waiting | `AskUserQuestion` → tool result; turn end → next prompt; `PermissionRequest` hook | `idle` → next `user` row; `permission.*` and `form.*` events, logged live by the plugin; `question` tool parts as fallback |
| Finalised | `SessionEnd` hook; `SessionStart` collects sessions that ended without it | `session.created` collects earlier sessions |

Markers and wait events live in `.claude/state/metrics/` of the main checkout (shared by git worktrees, not
committed); entries go to `docs/stories/metrics/` of the checkout the marker was set in.
