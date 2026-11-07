---
name: grilling
description: Grill the user relentlessly about a plan, decision, or idea. Use when the user wants to stress-test their thinking, or uses any 'grill' trigger phrases.
---

Interview the user relentlessly until you reach a shared understanding. Map this as a **design tree**: every decision branches into the decisions that hang off it.

Work the tree in **rounds**. The **frontier** is every decision whose prerequisites are already settled: the questions you can ask _now_ without guessing at answers you haven't heard yet. Ask the whole frontier in one round: number each question and give your recommended answer. Then wait for the user's answers before the next round.

Format a round like so:

```
❓ **Q1** - **<question title>**: <question body, might be multiple paragraphs, including multiple choices>

➡️ <your recommended answer>

---

❓ **Q2** - **<question title>**: <question body, might be multiple paragraphs, including multiple choices>

➡️ <your recommended answer>
```

Word each question so "yes" accepts your recommended answer.

Each round the user answers reshapes the tree: settled decisions push the frontier outward and unblock questions that depended on them. Recompute the frontier and ask the next round. A question whose answer depends on another question still open in this round belongs to a _later_ round, not this one.

Finding _facts_ is your job, never the user's. When a frontier question needs a fact from the environment (filesystem, tools, etc.), dispatch a sub-agent to find it; don't ask the user for anything you could look up yourself. Don't block on it: a running exploration is an unsettled prerequisite, so only the questions downstream of it wait for the sub-agent to report; ask the rest of the frontier now. The _decisions_ are the user's: put each to them and wait.

## Research before a round

When a frontier question depends on an external fact – authentication/identity, security, payment, privacy/data
protection, accessibility, performance, a new library or technology – load the `research` skill before the round. A
trigger is **not a mandate**: if `CONTEXT.md`, `docs/domain/events.yaml`, an accepted ADR, the UX guidelines, the
conventions or a valid research file already answers it, run nothing. One run per topic, not per story.

- The recommendation cites the finding and its source: `➡️ … (RFC 9700 §2.1.1; F1 in docs/research/oauth-pkce.md)`.
- Only a confirmed recommendation becomes a Gherkin scenario or checklist item with an observable threshold – never
  "follow best practices". A finding that cannot be tested is context or a guideline, not an acceptance criterion.
- Rejected options are recorded with the reason in the story's `## Context` / `## Out of Scope` (or the ADR /
  initiative). The research file stays evidence and is not rewritten into a decision log.
- A finding that contradicts `CONTEXT.md`, `events.yaml`, an accepted ADR or the UX guidelines is a grilling
  question. Never edit the model to match the source silently.

The session is done when the frontier is empty: every branch of the design tree visited, nothing left silently assumed. Do not act on it until the user confirms you have reached a shared understanding.