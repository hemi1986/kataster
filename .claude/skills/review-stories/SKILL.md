---
name: review-stories
description: Has stories checked in one lead-dev pass (value, build, UX), applies the small fixes and guides the user to approval (status ready).
disable-model-invocation: true
argument-hint: "[ST-IDs, empty = all with status review]"
---

# Story Review

The perspectives of product owner, lead dev and UX were settled with the user in the grilling. This review checks
that the stories carry them – one pass, not a second discovery (user, 2026-10-26).

1. **Selection**: Stories from the invocation arguments, or all with `status: review` in `docs/stories/`. With a
   tracker (`backlog.provider` ≠ `local`), pull first (`/backlog-sync pull`) so the review sees the tracker's state.
   None found → report and stop.
2. **Delegate once** to `lead-dev` with the full file paths of the stories, the review file path
   `docs/reviews/YYYY-MM-DD-story-review.md` and the task *story review: all three lenses*. It sets `size`, `risk`,
   `depends_on` and `priority` and writes the findings into the review file.
3. **Let the user decide** only what the findings leave open: conflicts with a decision from the grilling, a
   proposed split, a proposed new story (max. 3 questions at a time, each with a recommended answer). Adopt nothing
   that changes a grilling decision without consent.
4. **Apply**:
   - Small content changes (a scenario, a wording, a Context line, a G-reference) → edit the story yourself.
   - A split or a restructured story → delegate to `requirements-engineer` (referencing the review file).
   - With a tracker, push the selected stories that are still unlinked (`/backlog-sync push ST-001 …`) **before**
     setting `ready` – the push creates the issue and writes `external`; without it the validator refuses `ready`.
   - Approved stories: `node .claude/skills/implement/scripts/story-status.ts ST-NNN ready` (only if `size` is set
     and no `[OPEN]` remains – the script checks this). GitHub follows the status change directly; for Jira, run the
     transition the script prints.
   - Push the changed and approved stories again so body, labels and status agree in the tracker.
5. Wrap-up: run `node .claude/skills/user-stories/scripts/validate-stories.ts`, show the status overview and point to `docs/stories/BACKLOG.md` (regenerated automatically), where `ready` stories are queued for the engineering workflow.
