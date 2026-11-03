---
name: prototype
description: Build a throwaway prototype to answer one design question – a self-contained HTML file for a logic/state question, or several radically different UI variants switchable in one file. Use when a UX or domain question cannot be settled on paper, and in /feature or /implement when the user asks for a prototype.
---

# Prototype

A prototype is **throwaway code that answers a question**. The question decides the shape. It is not a first
draft of the feature: no tests, no persistence, no polish, no production path. The decision it settles is the
only thing that survives; the code is captured on a throwaway branch and never merged.

## When this is the right tool

Use it when the question is one of these, and the user agrees:

- **"What should this look like?"** – a structural layout choice: three genuinely different information
  hierarchies, not three colour variants.
- **"Does this logic / state model feel right?"** – a state machine, a set of rules or a data shape pushed
  through cases that are hard to reason about on paper.
- **"How should this flow feel?"** – a sequence a person walks through, where the order and the feedback are
  the question.

Do **not** prototype a question a guideline, the vision or the domain model already answers. Do not prototype
polish (colour, spacing, copy), and do not use it to avoid a grilling decision. The grilling comes first; the
prototype is evidence for one open branch of it.

## Pick a branch

Identify which question is being answered – from the user's prompt, the story, the surrounding code, or by
asking if the user is around:

- **"Does this logic / state model feel right?"** → [LOGIC.md](LOGIC.md). One self-contained HTML file with
  free-play buttons and tabbed guided walkthroughs that push the state model through the awkward cases. A
  non-developer can drive it.
- **"What should this look like?"** → [UI.md](UI.md). Several radically different variants in one
  self-contained HTML file, switchable via a `?variant=` URL search param and a floating bottom bar.

The two branches produce very different artifacts, so getting this wrong wastes the whole prototype. If the
question is genuinely ambiguous and the user isn't reachable, default to whichever branch better matches the
surrounding code (a backend module → logic; a page or component → UI) and state the assumption at the top of
the prototype.

## Where it lives

In discovery, the prototype is **standalone**: `docs/prototypes/<slug>/index.html`, written by the
`ux-designer`, with a short `README.md` next to it (question, branch, variants/scenarios, timebox, verdict).
No application code, no framework, no build step, no shell. The user opens the file in a browser.

A question that genuinely needs the real application – an existing page, real data, the real header and
sidebar – is an **in-app prototype**. That is the exception: it is built by the main session during
`/implement` (see [UI.md](UI.md)), not by the `ux-designer`, and it follows the project's routing convention
with a clearly marked throwaway route. The same capture rules apply.

## Rules that apply to both

1. **Throwaway from day one, and clearly marked as such.** The path or the first line says `PROTOTYPE`. Name
   it so a casual reader cannot mistake it for production.
2. **Trivial to run.** Standalone: double-click the HTML file. In-app: one command from the project's task
   runner. No thinking required to start it.
3. **No persistence by default.** State lives in memory. Persistence is the thing the prototype is *checking*,
   not something it depends on. If the question explicitly involves a database, use a scratch database or a
   local file with a clear "PROTOTYPE, wipe me" name.
4. **Skip the polish.** No tests, no error handling beyond what makes the prototype runnable, no abstractions.
   The point is to learn something fast.
5. **Surface the state.** After every action (logic) or on every variant switch (UI), render the full relevant
   state so the user can see what changed.
6. **One question, one timebox.** Write the question at the top, in the user's language, and agree a timebox
   with the user (one working session is the default). If the timebox expires without an answer, stop and
   record what is known – a second prototype needs a new question, not more polish.
7. **Capture the answer, not the code.** Fold the validated decision into the real artifact – the story's
   `## Context`, `docs/product/ux-guidelines.md` (a G-number when it is a recurring rule) or the domain model.
   Then capture the prototype itself as a **primary source**: commit `docs/prototypes/<slug>/` on a throwaway
   branch `prototype/<slug>`, push it only if the user wants to share it, and return to the branch you were
   on. The branch is never merged. The story carries `Prototype: prototype/<slug> – <question> – <verdict>`.

## How it plugs into the workflow

- **`/feature`** – the UX lens proposes a prototype when the frontier leaves a structural UI, flow or state
  question. The user decides. `--prototype[=ui|logic]` makes it explicit. The verdict goes to the
  `ux-designer` (guidelines) and into the story's `## Context` in the main session, before the stories are reviewed.
- **`/implement`** – only when the user asks (`--prototype`) or a spike's question is a UX/state question. A
  `ui` story whose screen shape is still open was not `ready`; the prototype settles it, then the story goes
  back to `review` if its behaviour changed. The engineering rule holds: never decide a story in the code.
- **The `ux-designer`** owns the skill and builds the standalone prototype. It never writes production code,
  tests or stories. The main session captures the branch and passes the verdict on.
