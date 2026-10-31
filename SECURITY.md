# Security policy

## Supported versions

Kataster is a `0.x` package: only the latest published version gets fixes. Upgrading is one command
(`npx kataster@latest upgrade` in an installed repository; `init` detects an existing installation and runs the
upgrade anyway), so there is no reason to stay on an older one.

## Reporting a vulnerability

**Do not open a public issue.** Use GitHub's private reporting:

<https://github.com/hemi1986/kataster/security/advisories/new>

Please include:

- the affected version (`npx kataster --version`) and how it was installed (`npx`, global, local)
- the harness and its version (Claude Code or OpenCode) if the problem is in a skill, agent or hook
- what happens, and what you expected instead – a minimal reproduction is worth more than a description
- whether secrets, project content or the user's repository can be affected

You get an acknowledgement within a few days. Once the report is confirmed, the fix ships as a patch release and the
advisory is published with credit, unless you ask to stay anonymous.

## Scope

Kataster writes files into a repository and runs plain Node scripts with the user's permissions. In scope:

- the installer overwriting, losing or leaking project content – anything that breaks the "never clobber user work"
  rule, including path traversal from `.claude/install.json` or from a repository it is run in
- a hook or script that executes untrusted input (a story frontmatter, a backlog field, a ticket body, a branch name)
  as code, shell or a path outside the repository
- publishing a tarball that differs from the source (supply chain: `npm publish` runs `prepublishOnly`, and the
  provenance of a release is checkable through the registry)
- a skill or agent instruction that would make an agent exfiltrate secrets, credentials or project content to a
  third party

Out of scope:

- what the *user's* agent does with the workflow – Kataster ships instructions and guardrails, not a sandbox
- findings that require an already-compromised machine, a malicious `.claude/project.json` the user wrote themselves,
  or a third-party CLI (`gh`, `git`, Jira MCP) misbehaving
- missing hardening without a demonstrated impact

## What the workflow does with your data

`init`, `upgrade` and `doctor` work offline. A backlog sync (`/backlog-sync`) talks to GitHub (`gh`) or Jira (the
`mcp-atlassian` MCP server) only when you run it. No telemetry, no phone-home, no analytics.
