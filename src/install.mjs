import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  exists, mergeUnique, parseJsonc, read, readJson, relPosix, sha, timestamp, toPosix, upsertBlock, write, writeJson,
} from "./util.mjs";

export const VERSION = readJson(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"))?.version ?? "0.0.0";
const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Everything the installer manages inside a target repository. */
const WORKFLOW_DIRS = [".claude", ".opencode"];
const SKIP = new Set(["node_modules", "state", "install.json", "project.json", "settings.local.json", ".npmignore", ".DS_Store"]);

const AGENTS_BEGIN = "<!-- kataster:begin – managed by kataster; edits inside are overwritten on upgrade -->";
const AGENTS_END = "<!-- kataster:end -->";
const CLAUDE_BEGIN = "<!-- kataster:claude:begin – imports the shared workflow; managed by kataster -->";
const CLAUDE_END = "<!-- kataster:claude:end -->";

/**
 * The tool was called La Guardia before 0.2. Repositories installed with that name carry its markers, its state
 * directory and its plugin path. They are rewritten on the way in, so an upgrade does not leave a second managed
 * block, a dead plugin or an orphaned backup directory behind.
 */
const LEGACY_MARKERS = [
  [/<!--\s*laguardia:begin[^>]*-->/, AGENTS_BEGIN],
  [/<!--\s*laguardia:end\s*-->/, AGENTS_END],
  [/<!--\s*laguardia:claude:begin[^>]*-->/, CLAUDE_BEGIN],
  [/<!--\s*laguardia:claude:end\s*-->/, CLAUDE_END],
];

const HOOK_EVENTS = {
  SessionStart: [
    {
      hooks: [
        { type: "command", command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/session-start.ts"' },
        { type: "command", command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/metrics.ts"', timeout: 30 },
      ],
    },
  ],
  PreToolUse: [
    {
      matcher: "Write|Edit|MultiEdit",
      hooks: [{ type: "command", command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/protect-files.ts"' }],
    },
    {
      matcher: "Bash",
      hooks: [
        { type: "command", command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/bash-guard.ts"' },
        { type: "command", command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/metrics.ts"' },
      ],
    },
  ],
  PostToolUse: [
    {
      matcher: "Write|Edit|MultiEdit",
      hooks: [
        { type: "command", command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/validate-docs.ts"' },
        { type: "command", command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/code-check.ts"', timeout: 90 },
        { type: "command", command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/project-check.ts"', timeout: 60 },
      ],
    },
  ],
  Stop: [{ hooks: [{ type: "command", command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/stop-gate.ts"', timeout: 600 }] }],
  // Story metrics: permission prompts are waiting time; a session's end finalises its metrics.
  PermissionRequest: [{ hooks: [{ type: "command", command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/metrics.ts"' }] }],
  SessionEnd: [{ hooks: [{ type: "command", command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/metrics.ts"', timeout: 30 }] }],
};

const ALLOW = [
  "Bash(node .claude/skills/event-storming/scripts/validate-events.ts)",
  "Bash(node .claude/skills/event-storming/scripts/render-event-storming.ts)",
  "Bash(node .claude/skills/user-stories/scripts/*)",
  "Bash(node .claude/skills/research/scripts/*)",
  "Bash(node .claude/skills/adopt/scripts/*)",
  "Bash(node .claude/skills/backlog/scripts/*)",
  "Bash(node .claude/skills/implement/scripts/*)",
  "Bash(node .claude/skills/metrics/scripts/*)",
  "Bash(node .claude/skills/marathon/scripts/*)",
  "Bash(gh issue *)",
  "Bash(gh label *)",
  "Bash(git status *)",
  "Bash(git diff *)",
  "Bash(git log *)",
];

/**
 * OpenCode's counterpart of one `ALLOW` entry: `Bash(<pattern>)` becomes a `shell` rule with the same pattern. Both
 * harnesses treat a trailing ` *` as optional arguments, so the patterns carry over unchanged. Null for an entry
 * without an OpenCode equivalent – the install test refuses one, so a new kind of entry needs a decision here.
 */
export function opencodeRule(entry) {
  const m = /^Bash\((.+)\)$/.exec(entry);
  return m ? { action: "shell", resource: m[1], effect: "allow" } : null;
}

/** `ALLOW` for OpenCode – `.opencode/opencode.jsonc` ships exactly these rules (checked by the install test). */
const OPENCODE_ALLOW = ALLOW.map(opencodeRule).filter(Boolean);

/**
 * Files earlier versions shipped and 0.4 removed. `upgrade` deletes them from an existing installation – but only
 * when the manifest tracks them and the local copy is unmodified, so a project that customised one keeps it.
 * Add a path here whenever a workflow file is retired; never prune by "not in the payload", because files from
 * optional extras and user-added agents are not the installer's to delete.
 */
const OBSOLETE = [
  ".claude/agents/product-owner.md",
  ".claude/agents/requirements-engineer.md",
  ".claude/agents/lead-dev.md",
  ".opencode/agents/product-owner.md",
  ".opencode/agents/requirements-engineer.md",
  ".opencode/agents/lead-dev.md",
];

export class Installer {
  constructor(root, { dryRun = false, force = false, restore = false, log = () => {} } = {}) {
    this.root = resolve(root);
    this.dryRun = dryRun;
    this.force = force;
    this.restore = restore;
    this.log = log;
    this.actions = [];
    this.manifestPath = join(this.root, ".claude", "install.json");
    this.manifest = readJson(this.manifestPath);
    this.files = { ...(this.manifest?.files ?? {}) };
    this.conflicts = [];
    this.created = [];
    this.updated = [];
    this.skipped = [];
    // A file the project deleted on purpose stays deleted on upgrade, like a removed conffile in dpkg: the manifest
    // remembers it, and only `upgrade --restore` brings it back. `seeded` lists the docs skeleton files the installer
    // has created; they are project content, so their hashes are not tracked, but a missing one was deleted.
    this.deleted = new Set(restore ? [] : this.manifest?.deleted ?? []);
    this.seeded = new Set(this.manifest?.seeded ?? []);
    // A manifest from before 0.6.3 has no `seeded` list. Every skeleton file was created at init or on an earlier
    // upgrade then, so a missing one counts as deleted.
    this.legacySeeded = Boolean(this.manifest) && !Array.isArray(this.manifest.seeded);
    this.shipped = new Set();
    this.keptDeleted = [];
  }

  /** Records that a file the project deleted stays deleted. */
  keepDeleted(path) {
    const key = relPosix(this.root, path);
    delete this.files[key];
    this.deleted.add(key);
    this.keptDeleted.push(key);
    this.record("deleted", path, "deleted in the project – not re-created (upgrade --restore brings it back)");
    return "deleted";
  }

  record(kind, path, detail = "") {
    this.actions.push({ kind, path: relPosix(this.root, path), detail });
    this.log(`${kind.padEnd(9)} ${relPosix(this.root, path)}${detail ? `  ${detail}` : ""}`);
  }

  backup(path) {
    if (this.dryRun || !existsSync(path)) return;
    const dir = join(this.root, ".kataster", "backup", timestamp());
    mkdirSync(dir, { recursive: true });
    const target = join(dir, relPosix(this.root, path).replaceAll("/", "__"));
    renameSync(path, target);
  }

  /**
   * Migrates an installation made under the old name: state directory, OpenCode plugin path and the markers in
   * AGENTS.md/CLAUDE.md. Idempotent and skipped in a dry run.
   */
  migrateLegacy() {
    const moves = [
      [join(this.root, ".laguardia"), join(this.root, ".kataster")],
      [join(this.root, ".opencode", "plugins", "laguardia"), join(this.root, ".opencode", "plugins", "kataster")],
    ];
    for (const [from, to] of moves) {
      if (!existsSync(from) || existsSync(to)) continue;
      if (!this.dryRun) renameSync(from, to);
      this.record("migrate", to, `from ${relPosix(this.root, from)}`);
    }
    for (const name of ["AGENTS.md", "CLAUDE.md"]) {
      const path = join(this.root, name);
      if (!existsSync(path)) continue;
      let text = read(path);
      for (const [pattern, replacement] of LEGACY_MARKERS) text = text.replace(pattern, replacement);
      if (text === read(path)) continue;
      if (!this.dryRun) write(path, text);
      this.record("migrate", path, "markers from the old name");
    }
  }

  /** Writes a managed workflow file, respecting local modifications on upgrade. */
  put(path, content, { merge = false, track = true } = {}) {
    const existing = existsSync(path) ? read(path) : undefined;
    const hash = sha(content);
    const key = relPosix(this.root, path);
    if (track && !merge) this.shipped.add(key);

    const wasDeleted = this.deleted.has(key);
    if (track && !merge && existing === undefined && !this.restore && (wasDeleted || key in (this.manifest?.files ?? {}))) {
      return this.keepDeleted(path);
    }
    // A file the project had deleted and then created again is the project's own: never overwrite it silently.
    if (wasDeleted) this.deleted.delete(key);

    if (existing === content) {
      if (track) this.files[key] = hash;
      return "unchanged";
    }

    if (existing !== undefined && !merge) {
      const known = this.manifest?.files?.[key];
      const local = sha(existing);
      const modifiedLocally = (known !== undefined && local !== known) || wasDeleted;
      if (modifiedLocally) {
        if (!this.force) {
          this.conflicts.push(key);
          this.record("conflict", path, "locally modified – kept (use --force to overwrite)");
          return "conflict";
        }
        this.backup(path);
      } else if (known === undefined && !this.force) {
        // A file from another tool with the same name: back it up, never silently lose it.
        this.backup(path);
      }
    }

    if (!this.dryRun) write(path, content);
    if (track) this.files[key] = hash;
    if (existing === undefined) {
      this.created.push(path);
      this.record("create", path);
      return "created";
    }
    this.updated.push(path);
    this.record("update", path);
    return "updated";
  }

  copyWorkflowDirs() {
    const present = new Set();
    for (const dir of WORKFLOW_DIRS) {
      const source = join(PKG, dir);
      if (!existsSync(source)) continue;
      for (const file of walk(source)) {
        const name = toPosix(relative(source, file));
        if (name.split("/").some((part) => SKIP.has(part))) continue;
        const key = relPosix(this.root, join(this.root, dir, name));
        present.add(key);
        // settings.json and opencode.jsonc are merged, not replaced
        if (file === join(source, "settings.json") || file === join(source, "opencode.jsonc")) continue;
        this.put(join(this.root, dir, name), read(file));
      }
    }
    this.pruneObsolete(present);
  }

  /**
   * Removes the retired workflow files listed in OBSOLETE (e.g. the deleted corporate-roleplay agents).
   *
   * Only files recorded in the manifest are candidates, so project content and files from other tools are never
   * touched. A file the user edited is kept and reported as a conflict – unless `--force` is given, which backs it
   * up first. This is what makes a removed agent actually disappear from an existing installation on upgrade.
   */
  pruneObsolete(present) {
    for (const key of OBSOLETE) {
      if (present.has(key)) continue;
      this.deleted.delete(key);
      if (!(key in (this.manifest?.files ?? {}))) continue;

      const path = join(this.root, key);
      if (!existsSync(path)) {
        delete this.files[key];
        continue;
      }

      const known = this.manifest.files[key];
      const local = sha(read(path));
      if (local !== known && !this.force) {
        this.conflicts.push(key);
        this.record("conflict", path, "retired, but locally modified – kept");
        continue;
      }
      if (this.force) this.backup(path);
      if (!this.dryRun) rmSync(path, { force: true });
      delete this.files[key];
      this.record("remove", path, "retired workflow file");
    }
  }

  mergeSettings() {
    const path = join(this.root, ".claude", "settings.json");
    const existing = readJson(path);
    const base = existing && typeof existing === "object" ? existing : {};
    const permissions = base.permissions ?? {};
    const hooks = { ...(base.hooks ?? {}) };

    for (const [event, entries] of Object.entries(HOOK_EVENTS)) {
      const ours = JSON.stringify(entries);
      // Remove only the hooks this installer manages, by exact command. A project may add its own hook under
      // .claude/hooks/ as well – that one must survive an upgrade.
      const managed = new Set(
        entries.flatMap((entry) => (entry.hooks ?? []).map((hook) => hook.command)).filter(Boolean),
      );
      const foreign = (hooks[event] ?? [])
        .map((entry) => ({
          ...entry,
          hooks: (entry.hooks ?? []).filter((hook) => !managed.has(hook.command ?? "")),
        }))
        .filter((entry) => (entry.hooks ?? []).length > 0);
      hooks[event] = [...foreign, ...JSON.parse(ours)];
    }

    const merged = {
      ...base,
      $schema: "https://json.schemastore.org/claude-code-settings.json",
      permissions: {
        ...permissions,
        allow: mergeUnique(permissions.allow ?? [], ALLOW),
        deny: permissions.deny ?? [],
        ask: permissions.ask ?? [],
      },
      hooks,
    };
    this.put(path, `${JSON.stringify(merged, null, 2)}\n`, { merge: true });
  }

  mergeOpencodeConfig() {
    const path = join(this.root, ".opencode", "opencode.jsonc");
    const template = read(join(PKG, ".opencode", "opencode.jsonc"));
    if (!existsSync(path)) {
      this.put(path, template);
      return;
    }
    const existing = parseJsonc(read(path));
    const ours = parseJsonc(template) ?? {};
    if (!existing) {
      this.record("skip", path, "existing config is not plain JSON/JSONC – left untouched");
      this.skipped.push(path);
      return;
    }
    const merged = {
      ...ours,
      ...existing,
      watcher: {
        ...(ours.watcher ?? {}),
        ...(existing.watcher ?? {}),
        ignore: mergeUnique(ours.watcher?.ignore ?? [], existing.watcher?.ignore ?? []),
      },
    };
    // Permission rules: the project's own first, ours appended when missing. OpenCode applies the last matching rule,
    // so a project's catch-all `ask` does not prompt for the workflow scripts – like Claude Code's allow list. A
    // project that writes something other than a rule list keeps it untouched.
    if (existing.permissions === undefined || Array.isArray(existing.permissions)) {
      const key = (rule) => [rule?.action, rule?.resource, rule?.effect].join("\0");
      const have = new Set((existing.permissions ?? []).map(key));
      merged.permissions = [...(existing.permissions ?? []), ...OPENCODE_ALLOW.filter((rule) => !have.has(key(rule)))];
    }
    this.put(path, `${JSON.stringify(merged, null, 2)}\n`, { merge: true });
  }

  mergeAgentsFile(profile) {
    const path = join(this.root, "AGENTS.md");
    const block = agentsBlock(profile);
    const existing = existsSync(path) ? read(path) : "";
    const next = upsertBlock(existing, block, { begin: AGENTS_BEGIN, end: AGENTS_END });
    this.put(path, next, { merge: true });
  }

  copyDocsSkeleton(profile) {
    const source = join(PKG, "templates", "docs");
    if (!existsSync(source)) return;
    for (const file of walk(source)) {
      this.seed(join(this.root, "docs", relative(source, file)), () => render(read(file), profile));
    }
  }

  /**
   * Creates a skeleton file once. An existing one is project content and kept; a missing one that was seeded
   * before was deleted by the project and stays deleted unless `--restore` is given.
   */
  seed(target, content) {
    const key = relPosix(this.root, target);
    this.shipped.add(key);
    if (existsSync(target)) {
      this.seeded.add(key);
      this.deleted.delete(key);
      this.record("keep", target);
      return "kept";
    }
    const known = this.seeded.has(key) || this.deleted.has(key) || this.legacySeeded;
    if (known && !this.restore) return this.keepDeleted(target);
    this.deleted.delete(key);
    this.seeded.add(key);
    return this.put(target, content(), { track: false });
  }

  putContext(profile) {
    const path = join(this.root, "CONTEXT.md");
    if (existsSync(path)) {
      this.record("keep", path);
      return;
    }
    this.put(path, render(read(join(PKG, "templates", "CONTEXT.md")), profile), { track: false });
  }

  /**
   * Claude Code's entry file: an import of AGENTS.md, so the rules live in one place.
   *
   * A repository often already has a CLAUDE.md with house rules. Claude Code then reads that file and does not
   * read AGENTS.md, so the import has to be added – without touching the existing content.
   */
  putClaudeMd(profile) {
    const path = join(this.root, "CLAUDE.md");
    const existing = existsSync(path) ? read(path) : undefined;
    if (existing === undefined) {
      this.put(path, `# ${profile.name ?? "Project"}\n\n@AGENTS.md\n`, { track: false });
      return;
    }
    if (existing.includes("@AGENTS.md")) {
      this.record("keep", path, "already imports AGENTS.md");
      return;
    }
    const block = `${CLAUDE_BEGIN}\n@AGENTS.md\n${CLAUDE_END}`;
    const start = existing.indexOf(CLAUDE_BEGIN);
    const stop = existing.indexOf(CLAUDE_END);
    const next = start !== -1 && stop > start
      ? `${existing.slice(0, start)}${block}${existing.slice(stop + CLAUDE_END.length)}`
      : `${block}\n\n${existing}`;
    this.put(path, next, { merge: true, track: false });
  }

  putProfile(profile) {
    const path = join(this.root, ".claude", "project.json");
    if (existsSync(path)) {
      this.record("keep", path, "existing project profile");
      return false;
    }
    this.put(path, `${JSON.stringify(profile, null, 2)}\n`, { track: false });
    return true;
  }

  putConventions(profile) {
    const path = join(this.root, "docs", "engineering", "conventions.md");
    this.seed(path, () => render(read(join(PKG, "templates", "conventions.md")), profile));
  }

  updateGitignore() {
    const path = join(this.root, ".gitignore");
    const entries = [".claude/node_modules/", ".claude/state/", ".kataster/"];
    const original = existsSync(path) ? read(path) : "";
    // An installation from before the rename still lists the old state directory.
    const existing = original.replace(/^\.laguardia\/$/m, ".kataster/");
    const missing = entries.filter((e) => !existing.split("\n").map((l) => l.trim()).includes(e));
    if (!missing.length && existing === original) return;
    const next = missing.length
      ? `${existing.trimEnd()}${existing.trim() ? "\n" : ""}\n# Kataster\n${missing.join("\n")}\n`
      : existing;
    this.put(path, next, { merge: true, track: false });
  }

  writeManifest() {
    if (this.dryRun) return;
    writeJson(this.manifestPath, {
      tool: "kataster",
      version: VERSION,
      installedAt: new Date().toISOString(),
      files: Object.fromEntries(Object.entries(this.files).sort(([a], [b]) => a.localeCompare(b))),
      seeded: [...this.seeded].sort(),
      // Only paths the payload still ships: a file the toolkit retired is no longer the installer's to remember.
      deleted: [...this.deleted].filter((key) => this.shipped.has(key)).sort(),
    });
  }

  installToolingDependencies() {
    if (this.dryRun) return { ok: true, skipped: true };
    if (!existsSync(join(this.root, ".claude", "package.json"))) return { ok: true, skipped: true };
    // A project that deleted the lockfile (e.g. a pnpm repository) must not get it back from npm either.
    const lockfile = existsSync(join(this.root, ".claude", "package-lock.json")) ? [] : ["--no-package-lock"];
    const r = spawnSync("npm", ["install", "--prefix", ".claude", "--no-audit", "--no-fund", ...lockfile], {
      cwd: this.root,
      stdio: "ignore",
    });
    return { ok: r.status === 0, skipped: false };
  }

  summary() {
    return {
      root: this.root,
      created: this.created.length,
      updated: this.updated.length,
      conflicts: this.conflicts,
      keptDeleted: this.keptDeleted,
      actions: this.actions,
    };
  }
}

export function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (entry.isFile()) out.push(path);
  }
  return out.sort();
}

export function agentsBlock(profile) {
  const name = profile.name;
  return `${AGENTS_BEGIN}
## ${name} – agent workflow (Kataster)

This repository runs the Kataster workflow. Discovery lives in \`.claude/skills/\`, the OpenCode wiring in
\`.opencode/\`; Claude Code uses the same skills and hooks.

- **Profile:** \`.claude/project.json\` – name, stack, languages, commands, backlog backend. Read it before assuming anything.
- **Backlog:** \`backlog.provider\` is \`local\` (default), \`github\` or \`jira\`. With a tracker, \`docs/stories/\` is the
  local mirror and the tracker is the source of truth – sync with \`/backlog-sync\`; \`BACKLOG.md\` stays generated.
- **Map:** \`docs/workflow.md\` – sources of truth, commands, phases, rules. Read it when unsure where something
  belongs.
- **Research:** cross-cutting questions go through the read-only \`researcher\` (\`/research\`,
  \`/feature --research\`); findings live in \`docs/research/<topic>.md\` with an expiry and are cited from a story's
  \`sources:\`. Evidence, not a specification.
- **Repo map (brownfield):** \`docs/architecture/repo-map.md\` – packages, dependency edges, consumers, adopted
  slices. A package's \`AGENTS.md\` is loaded only when you work there; the root file stays free of domain.
- **Start:** greenfield → \`/bootstrap\`; existing code → \`/adopt\` (in slices, not the whole monorepo).
- **Never guess:** unclear → a hotspot (\`HS-n\`) or \`[OPEN]\` plus a row in \`OPEN_QUESTIONS.md\`.
- **Project checks:** \`docs/engineering/checks.yaml\` – what runs at edit time and Stop/CI; architecture boundaries
  in \`docs/architecture/boundaries.yaml\` with existing debt in the baseline (only new violations fail).
- **Language:** domain terms exactly as in \`CONTEXT.md\`; UI words from its \`_UI (<lang>)_\` lines. Write docs,
  stories and ADRs in \`languages.artifacts\`; the installed templates are English and are translated as you fill them.
  What scripts read stays as in the template: frontmatter keys and values, the headings and markers listed in
  \`docs/workflow.md\`, Gherkin keywords and IDs.
- **1-command rule:** one story = one command + its events on one aggregate, at most 4 Gherkin scenarios. Full
  domain stories are \`type: domain\`; UI tweaks, refactors, dependencies and setup use the fast lane
  (\`type: chore\` or \`type: task\`).
- **Spec gate:** \`node .claude/skills/user-stories/scripts/lint-story.ts <file>\` must be green. A story the linter
  accepts becomes \`ready-for-human-review\`; only the user approves \`ready\`.
- **Traceability:** every domain scenario has a test titled \`ST-NNN: <scenario title>\`; domain IDs come from
  \`docs/domain/events.yaml\`.
- **ADRs:** new ones are \`proposed\`; only the user sets \`accepted\`. A \`done\` story is never reopened.
- **Reviews:** \`/implement\` scales review to the diff. \`code-reviewer\` and \`acceptance-tester\` report findings and
  never create stories; fast-lane stories skip the formal review pass.
- **Worker:** \`/implement --worker ST-NNN --base <branch>\` (agent \`story-worker\`) builds one given story and
  returns a JSON report instead of asking; an open decision is \`blocked\`, never code. It starts no subagent.
- **Marathon:** \`/marathon\` makes the main session the orchestrator of a run: story after story it claims the
  planned story, starts a \`story-worker\`, runs the reviews and merges into \`marathon/<date>\`; one pull request at
  the end. \`.claude/state/marathon.json\` changes only through \`marathon-state.ts\`; \`/marathon resume\` goes on.
- **Gate:** \`node .claude/skills/implement/scripts/verify.ts\`.
- **Metrics:** workflow skills mark their phases with \`story-metrics.ts mark\` (the \`metrics\` skill); never edit
  \`docs/stories/metrics/\`, commit it with the work.

Keep this block short: it is loaded into every session. Put rules into the skill that owns them, not here.
${AGENTS_END}`;
}

export function render(text, profile = {}) {
  return text
    .replaceAll("{{project}}", profile.name ?? "this project")
    .replaceAll("{{uiLanguage}}", profile.languages?.ui ?? "en")
    .replaceAll("{{artifacts}}", profile.languages?.artifacts ?? "en");
}

export function createInstaller(root, options) {
  return new Installer(root, options);
}

export { PKG, AGENTS_BEGIN, AGENTS_END, ALLOW, OPENCODE_ALLOW };
