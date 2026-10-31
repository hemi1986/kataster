# Reference files from the original project

These files come from the pinball-museum software **La Guardia**, the project this workflow was extracted from.
That project keeps its name; this toolkit used to share it and is now called Kataster. The files are **not part of
the npm package** (`files` in `package.json` excludes this folder) and the installer never copies them. They stay in
the repository as a reference for what a filled-in setup looks like.

- **`CLAUDE.origin.example.md`** – the original entry file. Useful as a model for a filled-in `docs/workflow.md`:
  sources of truth, skills, rules, workflow, tool access. The neutral version the installer writes is
  `templates/docs/workflow.md`.
- **`engineering-conventions.origin.example.md`** – the 800-line `docs/engineering/conventions.md` of a mature
  project: module layout, command layer, event journal, read models, UI texts, test data, and the seam catalog.
  Useful as a model for how detailed the conventions can get once the code exists.

They contain project-specific facts (including that project's database names). Do not copy them into a repository;
use them to see what "done" looks like.
