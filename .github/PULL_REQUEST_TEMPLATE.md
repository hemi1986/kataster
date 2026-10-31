<!-- Keep it short. The diff shows the rest. -->

## Problem

<!-- What is wrong or missing today? Link the issue if there is one: Fixes #123 -->

## Change

<!-- What does this pull request do, and why this way? -->

## Payload impact

<!-- Delete what does not apply. -->

- [ ] Touches the installer (`src/`) – tested against a temporary repository in `test/install.test.mjs`
- [ ] Touches the payload – stays project-neutral, and both harnesses are in sync (`.claude/` *and* `.opencode/`)
- [ ] Touches a skill or agent prompt – says which harness and stack it was tried on
- [ ] Docs only

## Verification

```bash
npm run typecheck --prefix .claude
npm test
npm pack --dry-run
```

<!-- Plus anything you did by hand: tarball install, `kataster doctor`, a real run in Claude Code / OpenCode. -->
