# Install, upgrade, troubleshoot

## Install

```bash
npx kataster init [dir]
```

| Option | Effect |
|---|---|
| `--brownfield` / `--greenfield` | Sets the starting path (default: detected from the code) |
| `--name <name>` | Project name (default: `package.json` name, else directory name) |
| `--ui-language <lang>` | Language of the user interface (default `en`) |
| `--artifacts <lang>` | Language of docs, stories, code comments (default `en`) |
| `--backlog <provider>` | Where stories live: `local` (default), `github`, `jira` |
| `--jira-project <key>` | Jira project key (with `--backlog jira`) |
| `--github-repo <repo>` | `owner/name` for a GitHub backlog (default: the current repository) |
| `--yes`, `-y` | Non-interactive: accept the detected defaults |
| `--no-install` | Skip `npm install --prefix .claude` |
| `--dry-run` | Show what would happen, write nothing |

The installer:

- copies `.claude/`, `.opencode/`, `AGENTS.md` and the `docs/` skeleton,
- **merges** into an existing `AGENTS.md` (marker block), `.claude/settings.json` (hooks and permissions) and
  `.opencode/opencode.jsonc` (watcher ignore list),
- detects stack, package manager, code roots and commands into `.claude/project.json`,
- records the backlog backend in `.claude/project.json` (`local`, `github` or `jira`),
- adds `.claude/node_modules/`, `.claude/state/` and `.kataster/` to `.gitignore`,
- installs the tooling dependency (`yaml`) into `.claude/`,
- records every managed file with a hash in `.claude/install.json`.

Existing `CONTEXT.md` and `docs/` are never overwritten.

## Verify the installation

```bash
npx kataster doctor
```

Checks Node version, workflow files, manifest, profile, tooling dependencies, the docs skeleton, whether
`docs/domain/events.yaml` validates, and the backlog backend (Jira project/MCP server or GitHub CLI/auth).

## Upgrade

```bash
npx kataster upgrade
```

- Workflow files that you did not change are replaced.
- Workflow files you **did** change are kept and listed as conflicts; `--force` overwrites them and writes a backup
  to `.kataster/backup/<timestamp>/`.
- Project content (`CONTEXT.md`, `docs/`, `.claude/project.json`) is never touched.
- An installation made under the old name (La Guardia) is migrated in place: `.laguardia/` becomes `.kataster/`, the
  OpenCode adapter moves to `.opencode/plugins/kataster/`, and the marker blocks in `AGENTS.md`/`CLAUDE.md` are
  rewritten. `backlog.labelPrefix` in `project.json` is kept, so labels already in GitHub or Jira stay valid.
- An existing `project.json` keeps its content. If it predates the backlog backend, add the `backlog` section by hand
  (see the README) – without it the provider stays `local`.
- An extra installed by an older version (`--with shadcn`, up to 0.2.1) stays on disk as a project file; upgrade no
  longer touches it. Delete `.claude/skills/shadcn/` if you do not want it.

## Harness setup

### OpenCode

Nothing to configure. `.opencode/commands/` provides the slash commands, `.opencode/agents/` the subagents, and
`.opencode/plugins/kataster/index.ts` wires the `.claude/hooks/*.ts` scripts into OpenCode's hook events.
`.opencode/opencode.jsonc` only holds watcher ignores.

### Claude Code

`.claude/settings.json` wires the same hooks (`SessionStart`, `PreToolUse`, `PostToolUse`, `Stop`). Skills in
`.claude/skills/` and agents in `.claude/agents/` are discovered automatically. Approve the project hooks once when
Claude Code asks.

### Both

Both harnesses read `AGENTS.md`. Claude Code reads `CLAUDE.md` first; the installer creates one containing
`@AGENTS.md`, or adds that import block to an existing `CLAUDE.md` without touching your house rules. The workflow
lives in `.claude/`; `.opencode/` is an adapter. An existing `.claude/` is merged: skills, rules and settings that
do not collide with a workflow file are left alone.

**Models.** OpenCode agents inherit the session's model; set `model:` in `.opencode/agents/*.md` if you want a
specific one per role (the review agents are the ones where a stronger model pays off). Claude Code agents use the
aliases `sonnet`/`opus` in `.claude/agents/*.md`; adjust them to the models you have.

### Backlog backends

`local` needs nothing. `github` needs the `gh` CLI, authenticated with the `repo` scope; set
`backlog.github.repo` if it is not the current repository. `jira` needs the `mcp-atlassian` server in your harness and
a real `backlog.jira.project`; the status and priority maps must match the project's workflow.

- Claude Code: add the server to `.mcp.json` and approve it once.
- OpenCode: add it to the `mcp` block in `opencode.jsonc`.

```jsonc
{
  "mcp": {
    "mcp-atlassian": {
      "type": "local",
      "command": ["uvx", "mcp-atlassian"],
      "enabled": true,
      "environment": { "JIRA_URL": "https://…", "JIRA_USERNAME": "…", "JIRA_API_TOKEN": "…" }
    }
  }
}
```

Then `/backlog-sync pull|push` (or the `backlog` skill) keeps `docs/stories/` in step with the tracker. The tracker is
the source of truth; the local directory is the mirror that validation and test traceability run on. Reviews and open
questions stay local.

## Troubleshooting

**"Tooling dependencies are missing"** – run `npm install --prefix .claude`. The validators and hooks need `yaml`.

**Hooks don't run in OpenCode** – the plugin spawns the project's `node`. If Node is not on `PATH`, set
`KATASTER_NODE` to the binary.

**`verify` skips project checks** – `commands` in `.claude/project.json` are empty. Fill in `lint`, `typecheck`,
`test` (and `e2e`) with the commands this repository actually uses.

**The stack detection is wrong** – it is a starting point. Edit `.claude/project.json`; nothing else reads the
detection.

**The backlog sync fails** – `npx kataster doctor` checks the provider. GitHub: `gh auth status`. Jira: the
`mcp-atlassian` server must be configured in the harness and `backlog.jira.project` must be set.
`node .claude/skills/backlog/scripts/backlog-status.ts` shows what is linked and what drifted.

**An accepted ADR can't be edited** – by design. Write a new ADR and set the old one's status to
`superseded by ADR-NNNN`. The hook allows exactly that.

**Upgrade reports conflicts** – those are files you changed. Review the diff, then either keep your version or run
`upgrade --force` (a backup is written to `.kataster/backup/`).
`upgrade --force` (backup is written).

## Uninstall

```bash
rm -rf .claude .opencode .kataster
# keep CONTEXT.md and docs/ – they are your project's domain
```

Remove the Kataster block from `AGENTS.md` and the `.gitignore` entries if you want a clean slate.
