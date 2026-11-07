# Kataster – development entry point

This repository is the **toolkit**, not an installation of it. `.claude/`, `.opencode/` and `templates/` are the
payload that `npx kataster init` copies into a target repository.

- **Installer:** `src/cli.mjs` (commands, prompts), `src/install.mjs` (copy, merge, manifest, upgrade),
  `src/detect.mjs` (stack detection), `src/repo.mjs` (monorepo tooling and workspaces), `src/util.mjs`.
- **Payload:** `.claude/` (skills, agents, hooks, lib, settings), `.opencode/` (commands, agents, plugin),
  `templates/` (docs skeleton, project profile defaults, conventions template).
- **Tests:** `npm test` (installs into temp directories and asserts the result).
- **Docs for users:** `README.md` and `guide/`.

Rules:

- The payload must stay project-neutral. No product names, no hardcoded stack, no hardcoded language. Project facts
  come from `.claude/project.json`; examples in skills use neutral domains.
- Every new workflow file goes into both harnesses (`.claude/agents` and `.opencode/agents`, command in
  `.opencode/commands`) or is deliberately harness-specific and documented as such.
- A file the installer manages is tracked in `.claude/install.json`; project content (`CONTEXT.md`, `docs/`,
  `project.json`, `AGENTS.md` block) is not. Never make an upgrade overwrite user content.
- Run `npm test` and `npm run typecheck --prefix .claude` before committing.

## Workflow contract (0.5)

The workflow is spec-driven and mechanical, not a simulated organisation:

- **No product-owner, requirements-engineer or lead-dev subagents.** The main session writes stories as a spec
  engineer with three lenses (domain, architecture, testability). Only the `ux-designer` remains on demand
  (`ui: true` / prototyping), and it never gates.
- **1-command rule:** one `type: domain` story = one command + its events on one aggregate, at most 4 Gherkin
  scenarios. `aggregate` and `command` are required frontmatter and are cross-checked against `docs/domain/events.yaml`.
- **Spec linter:** `.claude/skills/user-stories/scripts/lint-story.ts` (also `kataster lint-story`) is the gate.
  Green → `ready-for-human-review`; the user approves `ready`. No LLM pre-implementation review.
- **Research is evidence, not a specification.** Only the read-only `researcher` fetches web content (`/research`,
  `/feature --research`); findings live in `docs/research/<topic>.md` with an expiry and are cited from a story's
  `sources:`. A gated story (`risk: high` or a configured label) needs a resolvable source before
  `ready-for-human-review`; only a confirmed finding becomes a testable criterion.
- **Fast lane:** `type: chore` / `type: task`; `/implement` skips Gherkin matching and formal reviews.
- **Honest aggregates:** `status: target` (default when missing), `as-is` with evidence, or `unresolved` with an
  open hotspot. A story on an `unresolved` aggregate cannot leave `review`. `/adopt` writes `as-is`/`unresolved`,
  never an invented target.
- **Concept slices:** a layered repository is adopted by concept, not by package. The repo map marks generic layer
  packages and clusters shared stems/tables; `slice.ts` resolves globs, routes, tables, events, clusters or terms.
- **Characterization before test-first:** in the domain lane, an untested affected path gets a characterization
  test first, committed separately; a contradiction sends the story back to `review`.
- **As-is vs target:** `docs/domain/context-map.md` is the target; `/adopt` writes only
  `docs/domain/context-map.as-is.md`; the gap register links both.
- **Reviewers report, never plan:** `code-reviewer` and `acceptance-tester` create no stories. Findings are fixed in
  the story or handed back as open questions.
- The installer prunes the retired workflow files named in `OBSOLETE` (only manifest-tracked, unmodified ones), so a
  removed agent disappears on upgrade without touching optional extras or user files.
