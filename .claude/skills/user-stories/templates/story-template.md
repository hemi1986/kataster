---
id: ST-001
title: Short, domain-level title
type: domain
context: BC-Example
aggregate: AGG-Example
command: CMD-Example
ui: false
priority: should
size: null
risk: null
events: [EVT-Example]
depends_on: []
labels: []
status: draft
# sources: [docs/research/<topic>.md, https://…] – required for risk: high and the configured labels
# external: { provider: github|jira, key: "…", url: "…" } – written by /backlog-sync, never by hand
---

## Story
As a <role>, I want <goal>, so that <benefit>.

## Context
<Trigger, preconditions, business rules – from the command's rules and its aggregate's invariants>

## Acceptance Criteria

Scenario: <Happy path>
  Given <initial situation>
  When <action>
  Then <observable outcome>

Scenario: <Error or edge case>
  Given <initial situation>
  When <action>
  Then <observable outcome>

## Out of Scope
- …

## Open Questions
- none
