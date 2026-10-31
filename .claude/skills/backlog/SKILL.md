---
name: backlog
description: Keeps docs/stories/ in sync with the configured backlog backend – local (default), GitHub Issues via gh, or Jira via mcp-atlassian.
disable-model-invocation: true
argument-hint: "[status | pull | push] [ST-NNN ...]"
---

# Backlog Backend

`docs/stories/` is the exchange format, not necessarily the backlog. `.claude/project.json` decides where the source
of truth lives:

```jsonc
"backlog": {
  "provider": "local",                    // local | github | jira
  "github": { "repo": "", "labelPrefix": "kataster" },
  "jira": {
    "mcpServer": "mcp-atlassian",
    "project": "PROJ",
    "issueType": "Story",
    "labelPrefix": "kataster",
    "statusMap": {
      "draft": "To Do", "review": "In Review", "ready": "Ready",
      "in-progress": "In Progress", "done": "Done", "superseded": "Won't Do"
    },
    "priorityMap": { "must": "Highest", "should": "High", "could": "Medium", "wont": "Lowest" }
  }
}
```

| Provider | Source of truth | Transport |
|---|---|---|
| `local` | `docs/stories/` | none – the default, nothing changes |
| `github` | GitHub Issues | `gh` CLI (deterministic, works from scripts) |
| `jira` | Jira | `mcp-atlassian` (MCP is agent-only; the scripts prepare and consume the payloads) |

**With a tracker, the tracker leads.** `docs/stories/` is a local mirror that keeps validation, test traceability and
offline work intact. You may create and edit stories there; publish them through the sync. A change made in the
tracker is pulled into the mirror.

## Running a sync

- empty or `status` → `backlog-status.ts`: what is linked, what drifted.
- `pull` → GitHub: `backlog-pull.ts`; Jira: fetch with MCP, write the JSON, `backlog-pull.ts --from`.
- `push [ST-NNN …]` → GitHub: `backlog-push.ts`; Jira: `jira-plan.ts` → MCP → `jira-record.ts` → plan again for links.
- A single story argument limits push/plan to that story; pull processes every issue in the import.

## What syncs

Only the backlog core:

- the story body and `title`, `type`, `context`, `priority`, `size`, `risk`, `events`, `depends_on`, `labels`, `status`
- the external reference, `external: { provider, key, url }`
- nothing else: `docs/reviews/`, `docs/stories/OPEN_QUESTIONS.md`, ADRs and `BACKLOG.md` stay local. `BACKLOG.md` is
  generated from the mirror and never synced.

The story keeps its stable `ST-NNN` id; the tracker key lives in `external`. Test titles (`ST-NNN: <scenario>`) and the
domain IDs therefore do not change when a tracker is added. **Never renumber a story, never write `external` by hand.**

The issue body is the story body plus a machine block:

- GitHub: `<!-- kataster:story … -->` (hidden in the rendered issue)
- Jira: a ```` ```kataster-story … ``` ```` code block (Jira Cloud drops HTML comments when it converts Markdown to ADF)

The block restores the fields the tracker has no field for. The tracker wins for the fields it does have: status,
priority and the `kataster-*` labels.

## GitHub

`gh` must be installed and authenticated (`gh auth login`, `repo` scope). `repo` may be empty – then `gh` uses the
repository it runs in. Labels are created on demand.

```bash
node .claude/skills/backlog/scripts/backlog-status.ts   # what is linked, what drifted (--check exits 1)
node .claude/skills/backlog/scripts/backlog-push.ts     # create/update issues from the mirror
node .claude/skills/backlog/scripts/backlog-pull.ts     # import issue changes into the mirror
```

A story without `external` is created by `push`; an issue whose title starts with `ST-NNN:`, that carries the
`kataster` label, or that contains the machine block is picked up by `pull`. `done` and `superseded` close the issue;
`superseded` closes as "not planned". A status change through `story-status.ts` also updates the linked issue.

## Jira

Jira is reached through `mcp-atlassian`. A script cannot call MCP, so the agent is the transport and the scripts do
the mapping:

1. **Plan the push.**
   ```bash
   node .claude/skills/backlog/scripts/jira-plan.ts [ST-NNN ...]
   ```
   **Pull before you push.** `jira-plan` cannot see Jira, so it cannot detect a conflict; the import does. Fetch and
   import the issues first, then plan. A local file that the import left alone is safe to push; a conflict means the
   tracker won and the mirror is current.
   It prints JSON actions: `create` (`jira_create_issue`), `update` (`jira_update_issue`), `transition`
   (`jira_transition_issue`) and `link` (`jira_create_issue_link`). For a story with no `external.key` the action is
   `create`; its links are planned after the key exists.
2. **Execute with the MCP server named in `backlog.jira.mcpServer`.**
   - `create`: call `jira_create_issue` with the given `arguments`. Keep `key` and `browse_url` from the response.
   - `update`: call `jira_update_issue`.
   - `transition`: call `jira_get_transitions` for the issue first, pick the transition that reaches the `target`
     status, then call `jira_transition_issue`. If the issue is already there, skip it.
   - `link`: call `jira_create_issue_link`. `Blocks` is read as "outward issue blocks inward issue", so a story that
     depends on another has the dependency as `outward_issue_key`.
   - An action with `skip` is a note, not an MCP call: either the story is linked to another provider (fix the
     configuration or the external ref), or a link has to wait until the dependency has a Jira key. Re-run the plan
     after recording the missing key.
3. **Record the keys.**
   ```bash
   node .claude/skills/backlog/scripts/jira-record.ts --from results.json
   # [{"story":"ST-012","key":"PROJ-123","url":"https://…/browse/PROJ-123"}]
   ```
4. **Create the links.** Run `jira-plan.ts` again now that the keys exist and execute the `link` actions.
5. **Pull.**
   - Search with JQL `project = "<project>" AND labels = "kataster" ORDER BY key ASC`, or load the known keys
     individually with `jira_get_issue`; ask for `summary, description, status, labels, priority`.
   - Write the result as JSON and import it:
     ```bash
     node .claude/skills/backlog/scripts/backlog-pull.ts --from issues.json
     ```
     Accepted shape:
     ```json
     [{ "key": "PROJ-123", "summary": "ST-012: …", "description": "…", "status": "Ready",
        "labels": ["kataster", "kataster-status-ready"], "priority": "High",
        "browse_url": "https://…/browse/PROJ-123" }]
     ```
     `{ "key": "…", "fields": { "summary": "…", "description": "…", "status": { "name": "…" },
     "priority": { "name": "…" }, "labels": [] } }` is accepted too.

Jira may normalize Markdown on the way in and out. The mirror follows what Jira returns, so the first pull can
reformat a body; that is not a lost change. The machine block lives in a code block because Jira Cloud ADF drops HTML
comments.

`statusMap` and `priorityMap` must match the project's Jira workflow and priority scheme. If a status has no
transition, report it – do not invent one. The status label (`kataster-status-*`) is a fallback when the Jira status
name is not in the map. Jira labels allow only letters, numbers and a few separators, so story labels are sanitized on
the issue; the machine block keeps the original labels and restores them on a pull.

## Conflicts

The sync keeps a hash of the local file and of the remote issue at the last successful sync
(`.claude/state/backlog-sync.json`):

- **Remote changed, local unchanged** → pull updates the mirror.
- **Remote unchanged, local changed** → pull leaves the local story alone; push publishes it.
- **Both changed** → *the tracker wins*. Pull overwrites the mirror, backs the local file up to
  `.kataster/backup/backlog/<timestamp>/` and says so. Push refuses that story and tells you to pull first.
- **A local story has no external ref** → push creates it; pull reports it as local-only.
- **A linked issue disappeared** → reported as orphan. Nothing is deleted automatically.
- **Jira has no conflict detection in the plan** → pull first. The import compares the hashes and reports a conflict;
  only then is the mirror safe to push.

Never force a conflict away, never delete a story because its issue is gone, and never re-create an orphaned issue
silently – ask the user.

## When to sync

- after `requirements-engineer` created or changed stories → `push`
- after `product-owner` or `lead-dev` changed `priority`, `size`, `risk`, `depends_on` → `push`
- before `/review-stories` → `pull`, then review, then `push` the approved stories
- before `/implement` → `pull`; after each status change the workflow updates the tracker (GitHub directly, Jira by
  the printed MCP transition), and after `done` → `push`
- before `/groom-backlog` → `pull`; after applying the grooming → `push`
- a story must be linked before it reaches `ready` – the validator refuses an unlinked `ready` story in tracker mode

## Setup

**GitHub:** `backlog.provider: "github"`. Fill `backlog.github.repo` if it is not the current repository. Authenticate
`gh` once.

**Jira:** `backlog.provider: "jira"`, a real `backlog.jira.project`, and the `mcp-atlassian` server configured in the
harness. Claude Code: `.mcp.json`; OpenCode: the `mcp` block in `opencode.jsonc`:

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

Never put tokens in `.claude/project.json` or in a committed file. `/backlog-sync` reports a missing server, an empty
project or a missing `gh` login – tell the user, don't work around it.

## Rules

- `docs/stories/` is the mirror in tracker mode, not the source. Changes made there are pushed; changes made in the
  tracker are pulled.
- The tracker leads on conflict; the local file is backed up, never silently lost.
- Story labels must not start with the management prefix (`kataster` / `kataster-…`); those are owned by the sync.
- `ST-NNN` is stable. Do not renumber, do not change `external` by hand, do not edit `BACKLOG.md`.
- Reviews and open questions are local artifacts – do not push them.
- Report missing access (no `gh`, no MCP server, no transition) and let the user decide.
