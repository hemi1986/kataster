# Target context map – {{project}}

> Where the domain is going, not what the code does today. The as-is map is `context-map.as-is.md` and is
> written only by `/adopt`; the gap register links both sides. `/bootstrap`, `/shape`, `/feature`,
> `/event-storming`, `domain-architect` and `/improve-codebase-architecture` write this file.

<!--
  One section per bounded context: purpose, core terms, owner role. Relationships as a Mermaid flowchart
  using the DDD patterns: Customer/Supplier, Conformist, Anti-Corruption Layer, Shared Kernel,
  Published Language. 2–4 contexts are typical for a small system.
-->

```mermaid
flowchart LR
  %% BC-ExampleA -->|Customer/Supplier| BC-ExampleB
```

## Contexts

<!--
### BC-Example – <name>
Purpose: …
Core terms: …
Owner role: …
-->
