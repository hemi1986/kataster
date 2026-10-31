# Initiatives

Proposals for ideas larger than one feature, written by `/shape`. An initiative is **not** a work item: it has no
`ready`/`done`, creates no stories and never replaces `docs/stories/`. It answers four questions and ends with a
recommendation:

1. Should we do this at all?
2. Where does it belong – an existing bounded context, a new one, a shared library?
3. What changes, and what is genuinely new?
4. What does it roughly cost – in scope, range and risk?

File: `<slug>.md`, one per initiative. Status is `proposed` until the user accepts it; `parked` and `rejected` are
final until a new initiative replaces them. On handoff to `/feature`, set `promoted: <slug>` and let the stories
carry the label `feature:<slug>`.

```markdown
---
status: proposed          # proposed | accepted | parked | rejected
created: YYYY-MM-DD
source: ""                # optional ticket reference
promoted: ""              # feature:<slug> once slices are handed to /feature
---

# Initiative: <title>

## Problem & outcome
## Fit with the vision
## Placement
| Capability | Context | New/existing | Why | Confidence |
## Impact – change vs. build new
| Dimension | Change | New | Evidence |
## Slices
1. …
## Rough cost
| Currency | Estimate | Confidence | Basis |
## Risks & open questions
## Recommendation
```

Cost is always a range with a basis and a confidence – never a single number. An unknown is a line in the brief,
not a silent percentage.
