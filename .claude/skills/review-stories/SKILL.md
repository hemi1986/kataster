---
name: review-stories
description: Runs the deterministic spec linter on finished stories, fixes mechanical gaps, moves green stories to ready-for-human-review and guides the user to approval (status ready). No subagent review pass.
disable-model-invocation: true
argument-hint: "[ST-IDs, empty = all with status review]"
---

# Story Review

There is no simulated role play. The domain, architecture and testability decisions were made in the grilling and
the event storming; the **spec linter** now checks mechanically that the story carries them. The user approves; the
agent does not approve on their behalf.

1. **Selection**: Stories from the invocation arguments, or all with `status: review` in `docs/stories/`. With a
   tracker (`backlog.provider` ≠ `local`), pull first (`/backlog-sync pull`) so the review sees the tracker's state.
   None found → report and stop.
2. **Lint first** – this is the gate, not a suggestion:

   ```bash
   node .claude/skills/user-stories/scripts/lint-story.ts ST-NNN
   ```

   Errors are the agent's to fix in the story: a missing `aggregate`/`command`, a command that belongs to another
   aggregate, events that are not exactly what the command produces, a missing `Given/When/Then`, more than 4
   scenarios, duplicate titles, a broken reference. Do not weaken a check to get green – if the model is missing the
   event or aggregate, fix `docs/domain/events.yaml` (event-storming/domain-model skill) first.
3. **Warnings that matter**: a `ui: true` story with no empty/rejection case, a legacy `type: story`, a scenario that
   reads like a UX guideline restated. Fix what is clearly right; leave the rest as a note in the review summary.
   This is not a second discovery – adopt nothing that changes a decision from the grilling without asking.
4. **Research gate**: run

   ```bash
   node .claude/skills/research/scripts/research-check.ts --referenced
   ```

   A gate warning – a `risk: high` or gate-label story without a resolvable `sources:` entry – is **blocking** for
   the transition; `story-status.ts` refuses it. Add the source or revise the risk/labels with the user. Expired
   files are advisory for the gate, but refresh them before approval: a story is not approved on stale evidence. A
   missing local file on a non-gated story is only a warning; on a gated story it is the blocking case above.
5. **Tracker link**: with a tracker, push unlinked stories (`/backlog-sync push ST-001 …`) **before** setting
   `ready` – the push creates the issue and writes `external`; without it the validator refuses `ready`.
6. **Linter green → `ready-for-human-review`**:

   ```bash
   node .claude/skills/implement/scripts/story-status.ts ST-NNN ready-for-human-review
   ```

   The script validates the file and refuses on any lint error.
7. **The user approves** – present one short table (ID, title, type, command/aggregate, scenario count, warnings) and
   ask for approval. On approval:

   ```bash
   node .claude/skills/implement/scripts/story-status.ts ST-NNN ready
   ```

   With a tracker, push again so body, labels and status agree. If the user declines, the story goes back to
   `review` or `draft` with their reason.
8. **UX on demand only**: a story with `ui: true` may get a component/Figma proposal from the `ux-designer`, but
   only when the user asks. It is advice, never a gate – do not wait for it.
9. Wrap-up: run `node .claude/skills/user-stories/scripts/lint-story.ts`, show the status overview and point to
   `docs/stories/BACKLOG.md` (regenerated automatically), where `ready` stories are queued for engineering.
