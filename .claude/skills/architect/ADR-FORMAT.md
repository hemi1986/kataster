# ADR Format

ADRs live in `docs/adr/` and use sequential numbering: `0001-slug.md`, `0002-slug.md`, etc. Written in the artifact
language (`languages.artifacts` in `.claude/project.json`). The frontmatter keys and `status` values below stay
English, because the hooks read them.

## Template

```md
---
status: proposed
date: YYYY-MM-DD
---

# {Short title of the decision}

{1-3 sentences: what's the context, what did we decide, and why. Cite the driving requirement with its path, e.g. `docs/product/vision.md`.}
```

That's it. An ADR can be a single paragraph. The value is in recording *that* a decision was made and *why*, not in filling out sections.

## Status

The `status` frontmatter is mandatory, because decisions here go through the user:

- `proposed` – every new ADR, whoever writes it (main session or `domain-architect`)
- `accepted` – **set only by the user**
- `rejected`
- `superseded by ADR-NNNN` – a changed decision is a new ADR that replaces the accepted one

## Editorial changes

An accepted ADR keeps its decision. An editorial fix – a typo, an outdated file path, formatting – is allowed when
the same edit adds a dated line to an `## Editorial changes` section at the end of the ADR. `status` stays
`accepted`, and earlier lines stay:

```md
## Editorial changes
- 2026-11-22: path `src/orders/` → `apps/orders/` after the move
```

The `protect-files` hook allows exactly that. Anything that changes what was decided, why or its consequences is
not editorial: write a new ADR instead.

## Optional sections

Only include these when they add genuine value. Most ADRs won't need them.

- **Considered Options**: only when the rejected alternatives are worth remembering
- **Consequences**: only when non-obvious downstream effects need to be called out (incl. follow-up spikes or tech tasks)

## Large decisions

For decisions with several serious options and many criteria (e.g. the tech stack, see [TECH-STACK.md](./TECH-STACK.md)), use the full form:

```md
---
status: proposed
date: YYYY-MM-DD
---

# NNNN – {Short title}

## Context and Problem
{Which question is being decided, and why now?}

## Driving Requirements
- {Requirement} – source: `docs/...`

## Considered Options
1. {Option A}
2. {Option B}

## Evaluation
| Criterion | Option A | Option B |
|---|---|---|
| … | … | … |

## Decision
{Chosen option} – because {reasoning that follows from the evaluation}.

## Consequences
- Positive: …
- Negative / cost: …
- Follow-up work (spikes, tech tasks): …

## Open Points
- HS-… / questions
```

## Numbering

Scan `docs/adr/` for the highest existing number and increment by one.

## When to offer an ADR

All three of these must be true:

1. **Hard to reverse**: the cost of changing your mind later is meaningful
2. **Surprising without context**: a future reader will look at the system and wonder "why on earth did they do it this way?"
3. **The result of a real trade-off**: there were genuine alternatives and you picked one for specific reasons

If a decision is easy to reverse, skip it: you'll just reverse it. If it's not surprising, nobody will wonder why. If there was no real alternative, there's nothing to record beyond "we did the obvious thing."

### What qualifies

- **Architectural shape.** "The product is a single deployable PWA." "Cases are stored as an event history; their status is projected from it."
- **Integration patterns between contexts.** "Ordering and fulfilment communicate via domain events, not direct calls."
- **Technology choices that carry lock-in.** Database, auth provider, hosting, offline storage. Not every library: just the ones that would take a quarter to swap out.
- **Boundary and scope decisions.** "Product master data is owned by the catalogue context; others reference it by ID only." The explicit no-s are as valuable as the yes-s.
- **Deliberate deviations from the obvious path.** Anything where a reasonable reader would assume the opposite. These stop the next engineer from "fixing" something that was deliberate.
- **Constraints not visible in the system.** "Customers must be able to submit without an account." "The warehouse has no reliable Wi-Fi."
- **Rejected alternatives when the rejection is non-obvious.** Otherwise someone will suggest them again in six months.
