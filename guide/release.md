# Release

## 1. Prepare

1. Bump `version` in `package.json`. The package is `0.x`: a breaking change – a renamed command, a removed flag, a
   moved directory – bumps the minor number, everything else the patch number.
2. Move the `Unreleased` section of `CHANGELOG.md` under the new version.
3. Check the tree:

```bash
npm install --prefix .claude --no-audit --no-fund
npm run typecheck --prefix .claude
npm test
npm pack --dry-run        # 148 files, 218 kB – no examples/, no node_modules, no state/
```

4. Install the tarball once and start a throwaway project with it – a tarball that installs is not the same as a
   tarball that works:

```bash
npm pack
npm install -g --prefix "$(mktemp -d)" ./kataster-*.tgz
kataster init /tmp/smoke --yes
kataster doctor /tmp/smoke
```

## 2. Publish

### Through CI (the normal case)

The tag publishes. `v0.2.0` starts `.github/workflows/release.yml`, which checks that the tag matches
`package.json`, runs the type check and the suite, then publishes over OIDC – no npm token in the repository, no
one-time password, and provenance attestations are written automatically.

```bash
git push origin main
git tag -a v0.2.0 -m "Kataster 0.2.0"
git push origin v0.2.0
gh run watch
```

If the tag and `package.json` disagree, the workflow fails before it publishes – bump the version first, then tag.

### The first time only: trusted publisher

npm has to know which workflow may publish. On npmjs.com → `kataster` → Settings → **Trusted publishing** →
GitHub Actions:

| Field | Value |
|---|---|
| Organization or user | `hemi1986` |
| Repository | `kataster` |
| Workflow filename | `release.yml` |
| Environment name | – (leave empty) |
| Allowed actions | **Allow npm publish** (the default `npm stage publish` alone is not enough) |

The first publish has to succeed within **two days**, otherwise the configuration expires and has to be created
again. Once it works, lock the old path down: Settings → **Publishing access** → "Require two-factor authentication
and disallow tokens". Trusted publishers keep working; tokens and OTP stop working.

### By hand (fallback)

If CI is unavailable or a version has to go out without a tag:

```bash
npm login                 # once per machine
npm publish --access public
```

`prepublishOnly` runs the test suite, so a red suite cannot be published.

## 3. Verify

```bash
npm view kataster version
npx kataster@latest --version
```

The package page shows a provenance badge (`built and signed on GitHub Actions`) and the workflow run is linked to
the tag. A missing badge means the publish did not go through trusted publishing. The registry can take a minute or
two before a new version appears; `npm view kataster version` is the source of truth, not the cache in `npx`.

## What ships

`package.json` → `files` decides:

- `bin/`, `src/` – the CLI and installer
- `.claude/`, `.opencode/` – the payload the installer copies
- `templates/` – docs skeleton
- `guide/`, `README.md`, `AGENTS.md`, `CHANGELOG.md`, `LICENSE`

Not shipped: `test/`, `examples/`, `.github/`. `examples/` contains project-specific facts and is reference material
for the repository only.
