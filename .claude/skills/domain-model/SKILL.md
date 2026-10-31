---
name: domain-model
description: Build and sharpen the project's domain model – the ubiquitous language in CONTEXT.md, bounded contexts, context map, aggregates/invariants and the logical, stack-neutral data model based on docs/domain/events.yaml. Use when discussing domain terminology, writing or editing CONTEXT.md, or modeling contexts, aggregates and data.
---

# Domain Modeling

Actively build and sharpen the domain model as you go. This is the *active* discipline: challenging terms, inventing edge-case scenarios, and writing the glossary and the model down the moment they crystallise. (Merely *reading* `CONTEXT.md` for vocabulary is not this skill: that's a one-line habit every skill and agent has. This skill is for when you're changing the model, not just consuming it.)

Architecture decisions (ADRs, tech stack) belong to the `architect` skill. The domain comes first.

## Files

| What | Where |
|---|---|
| Glossary (ubiquitous language) | `CONTEXT.md` at the repo root – format: [CONTEXT-FORMAT.md](./CONTEXT-FORMAT.md) |
| Event storming model incl. `bounded_contexts`, `aggregates` | `docs/domain/events.yaml` |
| Context map | `docs/domain/context-map.md` |
| Logical data model | `docs/architecture/data-model.md` – template: `templates/data-model.md` |

## 1. Language (during every session)

### Challenge against the glossary
When the user uses a term that conflicts with the existing language in `CONTEXT.md`, call it out immediately. "Your glossary defines 'invoice' as X, but you seem to mean Y. Which is it?"

### Sharpen fuzzy language
When the user uses vague or overloaded terms, propose a precise canonical term. "You're saying 'order': do you mean the customer's request, or the shipment that fulfils it? Those are different things."

### Discuss concrete scenarios
When domain relationships are being discussed, stress-test them with specific scenarios. Invent scenarios that probe edge cases and force the user to be precise about the boundaries between concepts. "A customer reports the same problem on an item that already has an open case – a new case or the same one?"

### Cross-reference with docs and code
When the user states how something works, check whether `docs/domain/events.yaml`, the stories (and the code, once it exists) agree. If you find a contradiction, surface it.

### Update CONTEXT.md inline
When a term is resolved, update `CONTEXT.md` right there. Don't batch these up: capture them as they happen. `CONTEXT.md` is totally devoid of implementation details. It is a glossary and nothing else – not a spec, not a scratch pad.

Same word, different meaning in two places → a hint at a bounded context boundary (see 2).

## 2. Bounded Contexts & Context Map
- Draw boundaries along language (same word, different meaning → different context) and responsibility (who decides?).
- `docs/domain/context-map.md`: per context its purpose, core terms, owner role. Relationships as a Mermaid `flowchart` using the patterns Customer/Supplier, Conformist, Anti-Corruption Layer, Shared Kernel, Published Language.
- 2–4 contexts are typical for a small system. More only with justification.
- Maintain them in `events.yaml` under `bounded_contexts`, and group the terms in `CONTEXT.md` by context.

## 3. Aggregates
- An aggregate protects invariants that must be consistent **immediately**. Everything else is eventually consistent via events/policies.
- Keep them small. Reference other aggregates by ID only.
- Per aggregate in `events.yaml`: `context`, `invariants` (as testable statements). Assign commands and events via `aggregate`.
- **An invariant is stated once, on the aggregate** (user, 2026-10-01). A command's `rules` list only what it adds beyond them: defaults, actor permissions no invariant carries, required input, checks across aggregate or context boundaries, and consequences of the transition. Everything the stored state has to satisfy is an invariant, not a rule – the requirements-engineer reads both when deriving scenarios.
- Sign of a wrong aggregate: a command needs data from several aggregates to check a rule.

## 4. Logical Data Model (`docs/architecture/data-model.md`)
- Per aggregate: root entity, entities, value objects, attributes with **domain** types (e.g. `SerialNumber`, `Money`, `Timestamp`), required/optional.
- Lifecycle as a Mermaid `stateDiagram-v2` (derive states from the events).
- Overall view as a Mermaid `erDiagram` (logical, no database types).
- **Traceability**: every attribute comes from the `data` of an event or the `fields` of a read model. Attributes without a source → hotspot.
- Stack-neutral until an ADR decides the stack. After that, a "Physical Model" section may follow.

## 5. Quality Check Before Hand-off
- Every term used in events, commands and stories is in `CONTEXT.md`; no `_Avoid_` term is used anywhere.
- Every event has an aggregate or context, every command a trigger (actor or policy).
- No open hotspots that affect an aggregate or a context boundary – otherwise present them to the user.
- `node .claude/skills/event-storming/scripts/validate-events.ts` passes.
