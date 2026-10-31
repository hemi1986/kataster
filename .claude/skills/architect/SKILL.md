---
name: architect
description: Build and sharpen the project's architecture and record decisions as ADRs in docs/adr/ (incl. the tech stack decision). Use when discussing architectural shape, integration between bounded contexts, technology choices, or when recording or editing an ADR.
---

# Architecture

Actively build and sharpen the architecture as you design. This is the *active* discipline: challenging decisions, inventing scenarios that stress them, and writing decisions down the moment they crystallise. (Merely *reading* ADRs for context is not this skill. This skill is for when you're changing the architecture, not just consuming it.)

Domain language (the glossary in `CONTEXT.md`), bounded contexts, aggregates and the logical data model belong to the `domain-model` skill. Architecture builds on them: the domain comes first, technology follows.

## File structure

```
/
├── CONTEXT.md                  ← glossary (domain-model skill)
└── docs/
    ├── adr/                    ← architecture decisions (this skill)
    │   ├── 0001-tech-stack.md
    │   └── 0002-...
    ├── architecture/
    │   └── data-model.md       ← logical data model (domain-model skill)
    └── domain/
        ├── context-map.md
        └── events.yaml
```

Once code exists and contexts live in separate modules, context-specific decisions may move next to the code (`src/<context>/docs/adr/`); system-wide decisions stay in `docs/adr/`.

## During the session

### Challenge against existing decisions

When a proposal conflicts with an accepted ADR, call it out immediately: "ADR 0002 says reports work offline, but this assumes a live connection. Do we supersede 0002?" Accepted ADRs are never edited; they are superseded by a new one.

### Trace every decision back to a requirement

Architecture follows documented needs, not taste. Every decision cites its driving requirement with a path (`docs/product/vision.md`, `docs/domain/events.yaml`, a story, a hotspot). No documented requirement → no extra complexity. If the requirement is missing, it's a question for the user or a hotspot, not an assumption.

### Discuss concrete scenarios

Stress-test decisions with specific scenarios: "A field worker is in a basement without connectivity and wants to record a result – what happens?" "Two people close the same case at the same time." Force precision about the boundaries where the architecture could break.

### Cross-reference with docs and code

When the user states how something works, check `docs/` (and the code, once it exists) for agreement. Surface contradictions: "The data model has one owner per item, but you just said items can be lent with a second owner. Which is right?"

### Prefer the simplest architecture

The simplest architecture that meets the documented requirements is the default. Distributed systems, separate apps or microservices each need a concrete, documented requirement as justification.

### Offer ADRs sparingly

Only offer to create an ADR when all three are true:

1. **Hard to reverse**: the cost of changing your mind later is meaningful
2. **Surprising without context**: a future reader will wonder "why did they do it this way?"
3. **The result of a real trade-off**: there were genuine alternatives and you picked one for specific reasons

If any of the three is missing, skip the ADR. Use the format in [ADR-FORMAT.md](./ADR-FORMAT.md). New ADRs always start as `proposed`; **only the user sets `accepted`**.

### The tech stack decision

Decide only after the event storming and a rough domain model exist; before that the facts are missing. Follow [TECH-STACK.md](./TECH-STACK.md).
