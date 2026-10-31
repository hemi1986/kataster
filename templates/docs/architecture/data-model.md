# Logical data model – {{project}}

<!--
  Stack-neutral until an ADR decides the stack. Per aggregate: root entity, entities, value objects,
  attributes with domain types, required/optional. Lifecycle as a Mermaid stateDiagram-v2, overall view
  as an erDiagram. Every attribute traces back to an event's `data` or a read model's `fields`;
  anything without a source is a hotspot.
-->

## Aggregates

<!--
### AGG-Example – <name>
| Attribute | Type | Required | Source |
|---|---|---|---|
| … | … | yes | EVT-… |
-->

## Lifecycle

```mermaid
stateDiagram-v2
  %% [*] --> Example
```

## Overview

```mermaid
erDiagram
  %% AGG_EXAMPLE ||--o{ AGG_OTHER : references
```
