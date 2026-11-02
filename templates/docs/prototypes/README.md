# Prototypes

Throwaway code that answers one design question. The method is `.claude/skills/prototype/SKILL.md`.

- A prototype lives in `docs/prototypes/<slug>/` on a throwaway branch `prototype/<slug>`; it is never merged.
- The default branch keeps this README only. The prototype itself is a primary source on its branch.
- The decision it settled goes into the story (`Prototype: prototype/<slug> – <question> – <verdict>` in
  `## Context`) and, when it is a recurring rule, into `docs/product/ux-guidelines.md` as a G-number.
- One question, one self-contained HTML file, one timebox. No tests, no persistence, no production code.
