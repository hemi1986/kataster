# Contributing

Kataster is a toolkit, not a framework: a set of skills, agents, commands and a small installer that copies them
into someone else's repository. Contributions are welcome – bug reports, a skill that fills a real gap, a sharper
wording in a prompt, a detection case for a build tool we do not understand yet.

This file describes how to work on the repository. For how to work *with* Kataster, read the
[README](README.md) and the [guide](guide/README.md).

## Setup

```bash
git clone git@github.com:hemi1986/kataster.git
cd kataster
npm install --prefix .claude --no-audit --no-fund
```

Node **22.18+** is required (the tooling is TypeScript executed directly, there is no build step). The dependencies
of the payload live in `.claude/package.json` – the root `package.json` has none, on purpose: `npx kataster` must not
install a tree before it does anything.

## Before you open a pull request

```bash
npm run typecheck --prefix .claude
npm test
npm pack --dry-run
```

`npm test` runs the whole suite in `test/` (Node's own test runner, no framework). CI runs the same three commands
on Node 22 and 24, so a green local run is the whole gate.

If your change touches the installer or the payload, also install the tarball once and start a throwaway project
with it – a tarball that installs is not the same as a tarball that works:

```bash
npm pack
npm install -g --prefix "$(mktemp -d)" ./kataster-*.tgz
kataster init /tmp/smoke --yes
kataster doctor /tmp/smoke
```

## The rules the installer depends on

These are the constraints that keep the payload honest. A pull request that breaks one of them is not a style
question.

1. **The payload stays project-neutral.** No product names, no hardcoded stack, no hardcoded language, no paths
   that only exist in your project. Project facts come from `.claude/project.json`; examples use neutral domains
   (`acme/shop`, `orders`, `billing`).
2. **Every workflow file exists in both harnesses, or is deliberately harness-specific.** A skill lives in
   `.claude/skills/`, the matching slash command in `.opencode/commands/` loads it. An agent has a Claude Code file
   in `.claude/agents/` *and* an OpenCode file in `.opencode/agents/`, with the same name and the same instructions.
   Hooks exist once (`.claude/hooks/`) and are driven by the OpenCode adapter in `.opencode/plugins/kataster/`.
3. **Upgrade never destroys user content.** `CONTEXT.md`, `docs/`, `.claude/project.json` and the `AGENTS.md` block
   are project content. The installer may create them and may merge its own markers into a file, but it never
   overwrites what a user wrote. `.claude/install.json` records the hash of every managed file; that record is how an
   upgrade tells "ours, unmodified" from "the user edited this".
4. **No hidden state, no network at install time.** `init` reads the repository, writes files and asks four
   questions. Anything that needs the network (a backlog sync, a Jira fetch) belongs behind an explicit command.
5. **Third-party content is credited.** A skill, prompt or script taken from elsewhere goes into
   `.claude/THIRD_PARTY_NOTICES.md` with source, license, and whether it is copied or adapted – and its license text
   stays in that file, because the notice has to travel with every installed copy. The file ships with the payload.

## Adding to the payload

Files under `.claude/` and `.opencode/` are copied wholesale – the installer walks both directories and records what
it wrote, so a new file needs no registration. Two things it does *not* pick up on its own:

- **Permissions.** A new `scripts/*.ts` under `.claude/skills/<name>/` needs its `Bash(node …)` entry in `ALLOW` in
  `src/install.mjs`, or the command will be confirmed by the user at every call.
- **Settings and config.** `.claude/settings.json` and `.opencode/opencode.jsonc` are *merged*, not replaced. Hooks
  belong in `HOOK_EVENTS` in `src/install.mjs`; do not hand-edit the JSON that the installer generates.

### A skill

`.claude/skills/<name>/SKILL.md` with frontmatter (`name`, `description`, optional `argument-hint`,
`disable-model-invocation`) and the instructions. The `description` is the trigger, written for the agent that has to
decide whether to load it, not for a human browsing a list. Reference files go next to it; deterministic logic goes
into `scripts/` as plain TypeScript with no build step.

Then `.opencode/commands/<name>.md`: the same description, a body that loads the skill by name and passes
`$ARGUMENTS`. Keep it to a few lines – the skill is the instruction, the command is the entry point.

### An agent

Two files, one body:

- `.claude/agents/<name>.md` – frontmatter with `name`, `description`, `tools`, `model`, `color`, `skills`, `hooks`
- `.opencode/agents/<name>.md` – frontmatter with `description`, `mode: subagent`, `color`, `permissions`

The prose below the frontmatter is shared, because both harnesses run the same instructions. A review agent gets
read-only tools and, at most, write access to `docs/stories/` and `docs/reviews/` – reviews produce findings, not
fixes.

### A hook

`.claude/hooks/<name>.ts`, plain Node, no dependencies beyond the payload's own (`yaml`). Hooks must be quiet and
safe when there is nothing to do: a hook that fails on an unrelated repository breaks every installation. Register it
in `HOOK_EVENTS`, and test it through the CLI (`test/*.test.mjs` spawns `bin/kataster.mjs` against a temporary
repository).

### The installer

`src/cli.mjs` (commands, prompts), `src/install.mjs` (copy, merge, manifest, upgrade), `src/detect.mjs` (stack
detection), `src/repo.mjs` (monorepo tooling and workspaces). Tests live in `test/install.test.mjs` and build their
fixture in a temporary directory – never assert against this repository's own files.

## Tests

- One `test("<behaviour>", …)` per behaviour, named after what the user gets, not after the function.
- Every test creates its own repository under `os.tmpdir()` and runs the real CLI. There are no mocks for the
  installer, the hooks or the scripts – they are the product.
- A bug fix starts with a failing test. A skill change is a prompt change: test the deterministic part (the
  validator, the script, the install decision), not the wording.

## Commits and pull requests

- Branch off `main`, one topic per branch: `fix/upgrade-keeps-hooks`, `feat/backlog-linear`, `docs/contributing`.
- Commits are imperative and sentence case, without a type prefix: `Keep project hooks on upgrade`,
  `Detect Bazel BUILD packages`. The body explains *why* when the diff does not.
- A pull request states the problem, the change and how it was verified. If it changes behaviour of the payload,
  say which harness you tried it in and on which stack.
- `main` is protected: pull request, green CI, no force pushes. Small pull requests get reviewed faster than large
  ones – split along the seams (`installer` vs. `skill` vs. `docs`).

## Reporting

- **Bugs and ideas:** use the issue templates. Include Node version, harness (Claude Code or OpenCode), the command
  you ran and the output of `kataster doctor`.
- **Security:** do not open a public issue. See [SECURITY.md](SECURITY.md).
- **Conduct:** participation is covered by the [Code of Conduct](CODE_OF_CONDUCT.md).

## Releasing

Maintainers only. [guide/release.md](guide/release.md) has the steps: bump the version, move `Unreleased` in the
changelog, run the tree check, install the tarball once, then push a `v*` tag – CI publishes over OIDC with
provenance, no token and no one-time password. `prepublishOnly` runs the test suite again, so a red suite cannot be
published.
