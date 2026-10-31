# Kataster – development entry point

This repository is the **toolkit**, not an installation of it. `.claude/`, `.opencode/`, `templates/` and
`extras/` are the payload that `npx kataster init` copies into a target repository.

- **Installer:** `src/cli.mjs` (commands, prompts), `src/install.mjs` (copy, merge, manifest, upgrade),
  `src/detect.mjs` (stack detection), `src/repo.mjs` (monorepo tooling and workspaces), `src/util.mjs`.
- **Payload:** `.claude/` (skills, agents, hooks, lib, settings), `.opencode/` (commands, agents, plugin),
  `templates/` (docs skeleton, project profile defaults, conventions template), `extras/` (optional skills).
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
