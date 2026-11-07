# Research

Evidence for cross-cutting questions: authentication and identity, security, payment, privacy and data protection,
accessibility, performance, or a new library or technology. The files here are **evidence, not a specification** –
the user decides in grilling, and only a confirmed finding becomes a testable acceptance criterion.

One file per topic: `docs/research/<topic>.md`, lowercase kebab-case, no date in the file name. Refresh in place;
if the question changes materially, use a new topic.

## Format

```markdown
---
topic: oauth-pkce-spa
question: "Which PKCE configuration is required for a public SPA client?"
created: 2026-11-07
retrieved: 2026-11-07
expires: 2027-11-07
stack: ["next@15.2.0", "node@22.18.0"]
---

# Research: …
## Question
## Findings
### F1 – …
- **Statement:** …
- **Source:** <title> – <url> (<section>)
- **Retrieved:** YYYY-MM-DD
- **Tier:** 1 | 2 | 3
- **Confidence:** high | medium | low
- **Domain-model impact:** none | conflicts with `<term>` / `AGG-…` / ADR-… – what
## Conflicts, caveats and gaps
## Open questions for the grilling
```

Source tiers: **1** specs, standards and authorities (RFC, W3C/WAI, OWASP, NIST, ISO, GDPR/EDPB, PCI SSC, vendor
security advisories); **2** official documentation or source of the exact version in the lockfile; **3** everything
else – a hint, never the sole basis for a criterion.

## Expiry

`expires` is computed when the file is written or refreshed: `retrieved + research.expiryMonths` from
`.claude/project.json` (default 12 months, month-end clamped). It is not recomputed on every read. A stale file is
refreshed, not silently reused.

Check a file, every referenced file, or the whole directory:

```bash
node .claude/skills/research/scripts/research-check.ts --topic <slug>
node .claude/skills/research/scripts/research-check.ts --referenced
node .claude/skills/research/scripts/research-check.ts --all
```

Statuses are `VALID`, `EXPIRED`, `MISSING` and `INVALID`; exit 1 means at least one file needs a refresh or repair.
`verify.ts` runs the referenced check as an advisory step – an expired file warns, it never fails the gate.

## How research enters the work

- `/research <question>` runs the read-only `researcher`; the main session writes its findings verbatim into this
  directory. `/feature --research` forces the step for a topic the trigger list does not catch.
- The story lists the file under `sources:`. A story with `risk: high` or one of the configured gate labels in
  `.claude/project.json` (default `security`, `auth`, `payment`, `privacy`) needs at least one resolvable source
  before `ready-for-human-review`; the linter warns, `story-status.ts` blocks.
- Adopted findings become testable criteria with an observable threshold. Rejected options are recorded with the
  reason in the story, ADR or initiative – this file stays evidence, not a decision log.
- A finding that contradicts `CONTEXT.md`, `events.yaml`, an accepted ADR or the UX guidelines is a grilling
  question, never a silent rewrite of the model.

The full workflow is `.claude/skills/research/SKILL.md`; the format template is
`.claude/skills/research/templates/research.md`.
