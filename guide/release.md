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
npm pack --dry-run        # 161 files, 255 kB – no examples/, no node_modules, no state/
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

```bash
npm login                 # once per machine
npm publish --access public
```

`prepublishOnly` runs the test suite, so a red suite cannot be published.

Verify:

```bash
npm view kataster version
npx kataster@latest --version
```

## 3. Tag

The tag is the version with a `v`:

```bash
git tag -a v0.2.0 -m "Kataster 0.2.0"
git push origin main v0.2.0
```

## What ships

`package.json` → `files` decides:

- `bin/`, `src/` – the CLI and installer
- `.claude/`, `.opencode/` – the payload the installer copies
- `templates/`, `extras/` – docs skeleton and optional skills
- `guide/`, `README.md`, `AGENTS.md`, `CHANGELOG.md`, `LICENSE`

Not shipped: `test/`, `examples/`, `.github/`. `examples/` contains project-specific facts and is reference material
for the repository only.
