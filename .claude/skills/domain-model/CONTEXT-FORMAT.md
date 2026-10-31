# CONTEXT.md Format

`CONTEXT.md` at the repo root is the glossary – the single source of truth for domain language.

## Structure

```md
# <Project>

{One or two sentence description of the domain.}

## Language

### Defect Reporting

**Defect**:
{A one or two sentence description of the term}
_Avoid_: Bug, error, issue

**Defect report**:
A message from anyone about something wrong with an item, before it has been assessed.
_Avoid_: Ticket, complaint
_UI (en)_: report

### Workshop

**Repair**:
Work carried out by a technician to remove one or more defects from an item.
_Avoid_: Fix, service
```

## Rules

- **Be opinionated.** When multiple words exist for the same concept, pick the best one and list the others under `_Avoid_`.
- **Keep definitions tight.** One or two sentences max. Define what it IS, not what it does.
- **UI wording.** The UI language comes from `.claude/project.json` (`languages.ui`). Every term gets a
  `_UI (<lang>)_` line with the one word the UI uses for it – no synonyms in the UI either.
- **Only include terms specific to this domain.** General programming concepts (timeouts, error types, utility patterns) don't belong. Before adding a term, ask: is this a concept unique to the domain, or a general concept? Only the former belongs.
- **Group terms by bounded context** (subheadings named like the contexts in `docs/domain/events.yaml`) once contexts exist. Before that, a flat list is fine. Terms used across contexts go under `### Shared`.
- The same word with different meanings in two contexts gets one entry per context, each defined for its context.
- Names of events, commands etc. in `events.yaml` and all stories use these terms exactly.

## Single vs multi-context

During discovery there is one root `CONTEXT.md`, grouped by bounded context; the relationships between contexts are in `docs/domain/context-map.md`.

When code exists and contexts become separate modules, the glossary may be split: a root `CONTEXT-MAP.md` lists the contexts and links to one `CONTEXT.md` per module (e.g. `src/workshop/CONTEXT.md`). Only split when the code is actually structured that way – decide it via ADR.
