# Third-party notices

Kataster's workflow is partly derived from other people's work. This file says what came from where, so the credit
travels with the payload: it is copied into every installation together with the skills.

Everything not listed here is original to Kataster.

## Matt Pocock – Skills for Real Engineers

- Upstream: <https://github.com/mattpocock/skills>
- Site: <https://www.aihero.dev/skills>
- License: MIT, Copyright (c) 2026 Matt Pocock (full text below)

The grilling interview, the deep-module vocabulary, the test-first loop, the architecture survey and the
`writing-for-agents` reference are his. Some files are copied verbatim, others are adapted to Kataster's artifacts
(`CONTEXT.md` instead of `GLOSSARY.md`, the `skill` tool name in OpenCode, the seam catalog, the review agents):

| In Kataster | Upstream | State |
|---|---|---|
| `.claude/skills/grilling/SKILL.md` | `skills/productivity/grilling/SKILL.md` | adapted (naming, sub-agent wording) |
| `.claude/skills/grill-me/SKILL.md` | `skills/productivity/grill-me/SKILL.md` | copied (tool name) |
| `.claude/skills/grill-with-docs/SKILL.md` | `skills/engineering/grill-with-docs/SKILL.md` | adapted |
| `.claude/skills/writing-for-agents/SKILL.md` | `skills/productivity/writing-for-agents/SKILL.md` | copied verbatim |
| `.claude/skills/writing-for-agents/SKILL-MECHANICS.md` | `skills/productivity/writing-for-agents/SKILL-MECHANICS.md` | copied verbatim |
| `.claude/skills/codebase-design/SKILL.md` | `skills/engineering/codebase-design/SKILL.md` | copied verbatim |
| `.claude/skills/codebase-design/DEEPENING.md` | `skills/engineering/codebase-design/DEEPENING.md` | copied verbatim |
| `.claude/skills/codebase-design/DESIGN-IT-TWICE.md` | `skills/engineering/codebase-design/DESIGN-IT-TWICE.md` | adapted |
| `.claude/skills/tdd/SKILL.md` | `skills/engineering/tdd/SKILL.md` | adapted (glossary, seam catalog) |
| `.claude/skills/improve-codebase-architecture/SKILL.md` | `skills/engineering/improve-codebase-architecture/SKILL.md` | adapted (glossary, tool name) |
| `.claude/skills/retro/SKILL.md` | `skills/engineering/retro/SKILL.md` | adapted |
| `.claude/skills/domain-model/SKILL.md` | `skills/engineering/domain-modeling/SKILL.md` | adapted (contexts, aggregates, data model) |

Agents and commands built on top of them (`/implement`, `/feature`, `/review-stories`, `/groom-backlog`,
`/shape`, the review agents in `.claude/agents/`) are Kataster's own, but they stand on the same ideas: grilling as
a design-tree interview on the frontier, facts looked up rather than asked, decisions left to the user.

## Other ideas

- **John Ousterhout**, *A Philosophy of Software Design* – "Design It Twice" is the model for the parallel-interface
  exercise in `codebase-design`; depth, seam and the deletion test shape its vocabulary.
- **Eric Evans**, *Domain-Driven Design* – ubiquitous language, bounded contexts and aggregates shape the domain
  model and the glossary in `CONTEXT.md`.
- **Martin Fowler** – the smell baseline behind the review agents.

## MIT License

Copyright (c) 2026 Matt Pocock

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
