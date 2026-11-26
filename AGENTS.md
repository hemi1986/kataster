# Kataster – development entry point

This repository is the **toolkit**, not an installation of it. `.claude/`, `.opencode/` and `templates/` are the
payload that `npx kataster init` copies into a target repository.

- **Installer:** `src/cli.mjs` (commands, prompts), `src/install.mjs` (copy, merge, manifest, upgrade), `src/jsonc.mjs`
  (edits an existing `opencode.jsonc` in place – comments and formatting stay),
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
- **Worker mode:** `/implement --worker ST-NNN --base <branch>` (agent `story-worker`) builds one given story up
  to a green verify and returns a JSON report (`lib/worker.ts`, `implement/scripts/worker.ts`) instead of asking:
  `ready-for-review`, `blocked` or `returned-to-review`. `blocked` is a result of equal rank – an open decision is
  never made in code. The worker starts no subagent, pulls nothing and writes neither `CONTEXT.md` nor ADRs; reviews,
  `done` and the pull request stay with the orchestrator. The cut is the same in both harnesses and enforced in the
  agent files (`disallowedTools` / `subagent: deny`); the manual mode is untouched by it.
- **Marathon:** `/marathon` (skill `marathon`, user-invoked; `.opencode/commands/marathon.md` only loads it) makes
  the main session the orchestrator, serial for now (`marathon-plan.ts` refuses `--n` > 1). The decisions are pure
  functions in `lib/marathon.ts` (`stopReason`, `reviewNext`, `orphanAction`, `mergeErrors`, …) and
  `marathon/scripts/marathon-state.ts` is the only writer of `.claude/state/marathon.json`: lock file, temp + rename,
  validated before every write; a stale lock is broken with a warning, a broken state is never overwritten, and
  `protect-files.ts` blocks hand edits. The skill text carries no decision a script can make – exit 3 means the run
  stops. How a worker is started and continued differs per harness and is documented in the skill's last table
  (`Agent` + `SendMessage` / `subagent` + `sessionID`); everything else is one text for both. The quick gate
  (`stop-gate.ts`) is off while a claim is open.
- **Lease:** one orchestrator and one worker per run (`lib/lease.ts`, `.claude/state/marathon-lease.json`). The hooks
  append `--caller` to `worker.ts`/`marathon-state.ts`; `start-run`/`resume` and `worker.ts start` take the lease, a
  replaced session is refused by the scripts and blocked on every tool call by `hooks/marathon-guard.ts` (wired in
  `settings.json` and the OpenCode plugin). No heuristic watches for a second worker. `worker.ts report` keeps the
  report (`marathon-reports/`) so `resume` reads it instead of starting another pass.
- **Decided with a default:** a worker settles a technical detail the spec leaves open with the conservative default
  and reports it in `decisions` (never blocking); a domain gap stays `blocked`. The rule lives in the implement
  skill's worker mode; the PR summary lists the decisions for the user.
- **Merge blockers:** security and data protection (personal data exposed, missing authorization, injection), a 5xx
  answer to client input and an inconsistency that breaks a domain rule are never a default, a skipped finding or an
  open question (`lib/merge-blockers.ts`). `worker.ts report` refuses them as decisions, the reviewers tag them
  `merge-blocker: <kind>`, `marathon-state.ts review` counts the tags; one fix pass with the reviewer again, then
  escalation. `merge-check` (before `git merge`) and `result … merged` refuse an open one.
- **Reviewers report, never plan:** `code-reviewer` and `acceptance-tester` create no stories. Findings are fixed in
  the story or handed back as open questions.
- **Story metrics:** `/shape`, `/feature`, `/review-stories` and `/implement` mark phases with
  `.claude/skills/metrics/scripts/story-metrics.ts`. Usage comes from harness adapters (`lib/metrics-claude.ts`,
  `lib/metrics-opencode.ts`) that return the same `Stream` shape; entries store raw tokens only, the report prices
  them. Reviews (verdict, findings per severity) are records in the same file, written by `story-metrics.ts review`
  and `marathon-state.ts review`. A skill that marks a phase uses the phase names in `lib/metrics.ts` – one skill text serves both harnesses.
- The installer prunes the retired workflow files named in `OBSOLETE` (only manifest-tracked, unmodified ones), so a
  removed agent disappears on upgrade without touching optional extras or user files.
