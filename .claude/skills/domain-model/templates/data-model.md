# Logical Data Model

> Stack-neutral. Source: `docs/domain/events.yaml`. As of: <date>

## Overview

```mermaid
erDiagram
    AGGREGATE_A ||--o{ ENTITY_B : contains
```

## <Aggregate name> (`AGG-…`, context `BC-…`)

**Invariants**
- …

**Lifecycle**

```mermaid
stateDiagram-v2
    [*] --> StateA : EVT-…
    StateA --> StateB : EVT-…
```

| Element | Kind (root/entity/VO) | Attribute | Domain type | Required | Source (event/read model) |
|---|---|---|---|---|---|
| … | Root | … | … | yes | EVT-… |

**Open points:** HS-…
