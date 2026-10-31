---
name: groom-backlog
description: Periodic grooming of the open backlog – challenges whether stories are still worth building, whether dependencies still hold and whether the priorities still match what the product needs now.
disable-model-invocation: true
argument-hint: "[BC-Name | ST-IDs, empty = every story that is not done]"
---

# Backlog Grooming

Scope: the arguments from the invocation (empty → every story that is not `done`; `BC-Collection` → one bounded context; `ST-007 ST-008` → single stories).

`/review-stories` asks "is this new story ready to build?". Grooming asks the opposite question about what has been
lying around: **would we still write this story today?** The backlog was derived in one go from the event storming;
every done story, every ADR and every answered open question since then may have made part of it wrong, redundant
or differently important. Nothing here is a formality – a grooming run that changes nothing was a wasted run or a
healthy backlog, and you have to be able to say which.

Do **not** fix anything yourself. Grooming produces a decision for the user and a task for the `requirements-engineer`.

## 1. Mechanical health check

With a tracker (`backlog.provider` ≠ `local`), pull first (`/backlog-sync pull`) – grooming a stale mirror wastes the
run. Then:

```
node .claude/skills/groom-backlog/scripts/backlog-health.ts <scope>
```

Dependency cycles, stories waiting for dropped or non-existent ones, priority inversions, `ready` stories blocked
by `draft`, references to IDs `events.yaml` no longer has, stories that already have tests, parked `[OPEN]`
decisions and open questions older than 30 days. These are **findings, not errors** – they say where to look, the
judgement comes next. Read `docs/stories/BACKLOG.md` and `docs/stories/OPEN_QUESTIONS.md` as well.

## 2. What changed since the backlog was written

Before asking anyone else: build the list of changes the backlog may not have caught up with. `git log --oneline`
since the last grooming review in `docs/reviews/`, the stories that went `done`, new and superseded ADRs, answered
rows in `OPEN_QUESTIONS.md`, and the "revisit when …" lines parked in `docs/reviews/ST-NNN-code-review.md`. Hand
this list to the subagents – they cannot see it, and without it they re-read the same stories that were already
reviewed once.

## 3. Challenge in parallel

Start in **one** message, with the full file paths, the scope and the change list from step 2:

- `product-owner` – is the value still real and still in the vision? Is the story already covered by what was
  built? Does the MVP slice still hold? Which `must` is not a `must` any more, and which `could` turned out to be
  one? Which need from the vision still has no story?
- `lead-dev` – do `depends_on`, `size` and `risk` still fit **now that the code exists**? Which story has become
  smaller because the foundation is there, which bigger? Which dependency is technical fiction? Which story should
  be split, merged or dropped?
- `ux-designer` – only for stories with the label `ui` (or an obvious frontend part): does the story still match
  `docs/product/ux-guidelines.md`, and which one builds a screen that a newer story has replaced?

Tell each one explicitly: **recommend, don't rewrite** – they change only the frontmatter fields they own
(`priority` for the PO, `size`/`risk`/`depends_on` for the lead dev), everything else comes back as a proposal.

## 4. Consolidate

Write `docs/reviews/YYYY-MM-DD-backlog-grooming.md`:

- the health-check findings with what they turned out to mean
- per challenged story: keep / revise / split / merge / drop, with the reason and who said it
- conflicts between the three – name them, don't average them away
- proposed new stories, and stories proposed for `priority: wont`
- what explicitly stays as it is, so the next run does not re-litigate it

## 5. The user decides

Present it in rounds, at most 3 questions at a time, each with a recommended answer. Adopt nothing without consent.
A disagreement between PO and lead-dev is a question for the user, not something to resolve on their behalf.

## 6. Apply

- Content changes → `requirements-engineer`, referencing the grooming file.
- **Dropped stories are never deleted**: they get `priority: wont` and keep their file, so the decision stays
  traceable. A story that is wrong rather than unwanted goes back to `status: review` and through `/review-stories`.
- A `done` story is never reopened – a change to finished behaviour is a new story.
- New stories from the grooming get `status: draft` and go through `/review-stories` like any other.
- With a tracker, push the applied changes (`/backlog-sync push`) before the wrap-up, so Jira/GitHub and the mirror
  agree. A story that is not linked yet stays a local draft until the push creates it.

## 7. Wrap-up

`node .claude/skills/user-stories/scripts/validate-stories.ts`, then the health check again – the findings you
decided to act on should be gone, and you should be able to say why each remaining one stays. Summarize in a few
lines: how many stories were challenged, what changed, what was dropped, what the user still has to decide.

## When to run it

After a bounded context is finished, after a `/feature` has landed, or roughly every 8–10 done domain stories –
and always before planning a larger block of work. Not between two stories of the same context: the backlog has
not moved by then, and a grooming run that finds nothing twice in a row means the interval is too short.
