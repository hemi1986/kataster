---
name: engineering-conventions
description: How the code is built in this repository – module layout, commands, event journal, version checks, policies, read models, time-based rules, UI texts, test data and the seam catalog. Read it before planning or writing code for a story (/implement), and in code reviews.
---

# Engineering Conventions

The conventions themselves live in **`docs/engineering/conventions.md`** – they are repository-specific and grow
with the code. This skill is the rule for using them:

1. **Read `docs/engineering/conventions.md` before writing code for a story.** It overrides general preferences.
   If the file is missing or still full of `[OPEN]` markers, say so: the conventions are written after the
   foundation stories exist (or by `/adopt` for an existing codebase), not before.
2. **The seam catalog lives there.** `/implement` only stops for the user when a story needs a seam that is not in
   the catalog; seams in the catalog are pre-approved.
3. **When code and conventions disagree, raise it** – don't silently follow either. A change to the conventions is
   a decision for the user, and `/retro` is the place to propose it.

The document must answer, at minimum:

| Topic | Question it answers |
|---|---|
| Module layout | Which directories exist, what belongs in each, which imports are allowed across them? |
| Commands and events | How does a command run (transaction, authorization, version check)? Where do domain events go? How are automatic policies triggered? |
| Read models | Where do queries live, how do they stay out of the write path? |
| Time-based rules | How is "now" injected so due/overdue rules are testable? |
| UI and texts | Where do texts live, in which language(s), which shared frames/components exist? |
| Test data and seams | Test data builders, fixed clock, database per run – and the seam catalog: which seam each kind of code is tested at. |

`templates/conventions.md` in the Kataster package is the starting point the installer copies to
`docs/engineering/conventions.md`.
