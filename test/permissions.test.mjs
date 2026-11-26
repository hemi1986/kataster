import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ALLOW, OPENCODE_ALLOW } from "../src/install.mjs";
import { covers, fileRules, matches, overlaps, planRules } from "../src/permissions.mjs";
import { parseJsonc } from "../src/util.mjs";

const cli = resolve(dirname(fileURLToPath(import.meta.url)), "..", "bin", "kataster.mjs");

function repo(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), "kataster-perm-"));
  for (const [path, content] of Object.entries({ "package.json": "{}", ...files })) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), typeof content === "string" ? content : JSON.stringify(content, null, 2), "utf8");
  }
  return dir;
}
const run = (args) => {
  const r = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};
const install = (dir) => {
  const r = run(["init", dir, "--yes", "--no-install"]);
  assert.equal(r.code, 0, r.out);
  return r;
};
const read = (dir, path) => readFileSync(join(dir, path), "utf8");
const opencode = (dir) => parseJsonc(read(dir, ".opencode/opencode.jsonc"));
const rule = (resource, effect, action = "shell") => ({ action, resource, effect });

/**
 * OpenCode's decision for a shell command, written here from what OpenCode 2.4.1 does – not with the installer's own
 * helpers: the last rule whose action and resource match wins, `allow` when none does; `*` is any text, a trailing
 * ` *` is optional.
 */
function decide(rules, command) {
  const hit = (pattern, text) => {
    let re = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
    if (re.endsWith(" .*")) re = `${re.slice(0, -3)}( .*)?`;
    return new RegExp(`^${re}$`, "s").test(text);
  };
  return rules.filter((r) => hit(r.action, "shell") && hit(r.resource, command)).at(-1)?.effect ?? "allow";
}

const OWN = [
  "node .claude/skills/backlog/scripts/backlog-push.ts",
  "node .claude/skills/implement/scripts/verify.ts",
  "node .claude/skills/marathon/scripts/marathon-state.ts status",
  "node .claude/skills/user-stories/scripts/lint-story.ts ST-001",
];
const OTHER = [
  "gh issue list", "gh issue delete 7", "gh label create x", "gh pr merge 3", "git status", "git diff HEAD", "git log -1",
  "git push origin main", "rm -rf build", "npm publish", "node scripts/seed.js",
];
const STRICTNESS = { allow: 0, ask: 1, deny: 2 };

/** No command is less restricted after the upgrade – but for an `ask` about Kataster's own scripts. */
function assertNotLoosened(before, after) {
  for (const command of [...OWN, ...OTHER]) {
    const [was, is] = [decide(before, command), decide(after, command)];
    const intended = OWN.includes(command) && was === "ask" && is === "allow";
    assert.ok(STRICTNESS[is] >= STRICTNESS[was] || intended, `loosened: '${command}' was ${was}, is ${is}`);
  }
}

/** Upgrades a project whose own config holds `permissions` and returns the effective rules after it. */
function upgraded(permissions) {
  const dir = repo({ ".opencode/opencode.jsonc": { permissions } });
  const first = install(dir);
  const text = read(dir, ".opencode/opencode.jsonc");
  install(dir);
  assert.equal(read(dir, ".opencode/opencode.jsonc"), text, "a second upgrade changes nothing");
  return { dir, out: first.out, rules: opencode(dir).permissions };
}

const warnings = (dir) => {
  const r = run(["doctor", dir]);
  return r.out.split("\n").filter((l) => /^\s+! (OpenCode|Claude Code)/.test(l));
};

test("upgrade of a project with `shell * deny`: everything stays denied, doctor says what that blocks", () => {
  const own = [rule("*", "deny"), rule("npm test", "allow")];
  const { dir, out, rules } = upgraded(own);
  assertNotLoosened(own, rules);
  for (const command of [...OWN, ...OTHER]) assert.equal(decide(rules, command), "deny", command);
  assert.deepEqual(rules.slice(-2), own, "the project's rules are last, in their order");
  assert.match(out, new RegExp(`${OPENCODE_ALLOW.length} Kataster allow rule\\(s\\) added in front of it, where it wins, because of your \`shell \\*\` deny`));

  const [warning, ...rest] = warnings(dir);
  assert.deepEqual(rest, [], "one warning per rule of the project");
  assert.match(warning, new RegExp(`! OpenCode: ${OPENCODE_ALLOW.length} Kataster rule\\(s\\) do not take effect because of your \`shell \\*\` deny`));
  assert.match(warning, /the backlog sync \(\/backlog-sync\).*will be blocked/);
  assert.match(run(["doctor", dir]).out, /1 warning\(s\)\./);
});

test("upgrade of a project with `shell * ask`: only Kataster's own scripts run without asking", () => {
  const own = [rule("*", "ask")];
  const { dir, rules } = upgraded(own);
  assertNotLoosened(own, rules);
  for (const command of OWN) assert.equal(decide(rules, command), "allow", command);
  for (const command of OTHER) assert.equal(decide(rules, command), "ask", command);

  const [warning, ...rest] = warnings(dir);
  assert.deepEqual(rest, []);
  assert.match(warning, /! OpenCode: 5 Kataster rule\(s\) do not take effect because of your `shell \*` ask/);
  assert.match(warning, /`gh issue` calls.*git status\/diff\/log.*will ask for approval \(an unattended run waits there\)/);
  assert.doesNotMatch(warning, /backlog sync \(\/backlog-sync\)/);
});

test("upgrade of a project with a targeted deny on gh: it stays, the rest works", () => {
  const own = [rule("gh issue delete *", "deny"), rule("gh label *", "deny")];
  const { dir, rules } = upgraded(own);
  assertNotLoosened(own, rules);
  assert.equal(decide(rules, "gh issue delete 7"), "deny");
  assert.equal(decide(rules, "gh label create x"), "deny");
  assert.equal(decide(rules, "gh issue list"), "allow", "the rest of gh issue is untouched");
  for (const command of OWN) assert.equal(decide(rules, command), "allow", command);

  const found = warnings(dir);
  assert.equal(found.length, 2, found.join("\n"));
  assert.match(found[0], /1 Kataster rule\(s\) do not take effect because of your `shell gh issue delete \*` deny .*`gh issue` calls.*blocked, at least in part; `gh issue \*`/);
  assert.match(found[1], /because of your `shell gh label \*` deny .*`gh label` calls/);
});

test("a deny in another config file or an older key cannot be placed behind – the rule is left out", () => {
  // OpenCode reads these before .opencode/opencode.jsonc, so any allow written there would win over them.
  const cases = [
    { "opencode.json": { permissions: [rule("gh issue *", "deny")] } },
    { "opencode.jsonc": `// root\n{ "permission": { "bash": { "gh issue *": "deny" } } }` },
    { ".opencode/opencode.json": { permissions: [rule("gh issue *", "deny")] } },
    { ".opencode/opencode.jsonc": { permission: { bash: { "gh issue *": "deny" } } } },
  ];
  for (const files of cases) {
    const dir = repo(files);
    const out = install(dir).out;
    const resources = (opencode(dir).permissions ?? []).map((r) => r.resource);
    assert.ok(!resources.includes("gh issue *"), `${Object.keys(files)}: not added`);
    assert.ok(resources.includes("gh label *") && resources.includes("node .claude/skills/backlog/scripts/*"), "the others are");
    assert.match(out, /1 Kataster allow rule\(s\) not added, because of your `shell gh issue \*` deny/);
    assert.match(warnings(dir).join("\n"), /because of your `shell gh issue \*` deny/);
    install(dir);
    assert.ok(!(opencode(dir).permissions ?? []).some((r) => r.resource === "gh issue *"), "not on the next upgrade either");
  }
});

test("`shell * deny` elsewhere – root config, `tools`, a parent directory – means no allow rule at all", () => {
  for (const files of [
    { "opencode.json": { permissions: [rule("*", "deny")] } },
    { "opencode.json": { tools: { bash: false } } },
    { ".opencode/opencode.jsonc": { permission: "deny" } },
  ]) {
    const dir = repo(files);
    install(dir);
    assert.deepEqual(opencode(dir).permissions ?? [], [], Object.keys(files).join());
    assert.equal(opencode(dir).automations, false);
  }
  const parent = repo({ ".git/HEAD": "ref: refs/heads/main\n", "opencode.json": { permissions: [rule("git *", "ask")] }, "app/package.json": "{}" });
  const app = join(parent, "app");
  install(app);
  const resources = opencode(app).permissions.map((r) => r.resource);
  assert.ok(!resources.some((r) => r.startsWith("git ")), "the parent's ask on git holds");
  assert.ok(resources.includes("gh issue *"));
});

test("an unreadable config adds no allow rule; a root `automations` choice stays the effective one", () => {
  const broken = repo({ "opencode.json": "{ not json" });
  assert.match(install(broken).out, /not added, because of opencode\.json cannot be read/);
  assert.deepEqual(opencode(broken).permissions, []);
  assert.match(run(["doctor", broken]).out, /! OpenCode: opencode\.json cannot be read/);

  const fresh = repo({ "opencode.json": { automations: true } });
  install(fresh);
  assert.equal(opencode(fresh).automations, true, "our file comes last in OpenCode – it must not switch theirs off");
  const existing = repo({ "opencode.json": { automations: true }, ".opencode/opencode.jsonc": { model: "x/y" } });
  install(existing);
  assert.equal(opencode(existing).automations, undefined);
});

test("a project without restrictions gets the same file as before, and doctor is quiet", () => {
  const dir = repo();
  const out = install(dir).out;
  assert.deepEqual(opencode(dir).permissions, OPENCODE_ALLOW);
  assert.doesNotMatch(out, /Permissions – please check/);
  assert.deepEqual(warnings(dir), []);
  // Guards against a detail of any command, placed last as the README says: no noise.
  const guarded = repo({ ".opencode/opencode.jsonc": { permissions: [rule("*", "deny"), ...OPENCODE_ALLOW, rule("*--force*", "deny"), rule("git push *main*", "deny")] } });
  install(guarded);
  assert.deepEqual(warnings(guarded), []);
});

test("doctor names a project rule that a Kataster rule after it overrides", () => {
  const dir = repo({ ".opencode/opencode.jsonc": { permissions: [rule("gh issue delete *", "deny"), ...OPENCODE_ALLOW] } });
  install(dir);
  assert.match(warnings(dir).join("\n"), /! OpenCode: your `shell gh issue delete \*` deny is overridden by a Kataster rule after it .*`gh issue \*` wins.*move yours after/);
});

test("Claude Code: the project's deny and ask stay as they are, and doctor says what they block", () => {
  const permissions = { allow: ["Bash(make test)"], deny: ["Bash(gh issue *)", "Read(.env)"], ask: ["Bash(git log:*)"], defaultMode: "default" };
  const dir = repo({ ".claude/settings.json": { permissions } });
  install(dir);
  install(dir);
  const merged = JSON.parse(read(dir, ".claude/settings.json")).permissions;
  assert.deepEqual([merged.deny, merged.ask, merged.defaultMode], [permissions.deny, permissions.ask, "default"]);
  assert.deepEqual(merged.allow, ["Bash(make test)", ...ALLOW]);

  const found = warnings(dir).filter((l) => l.includes("Claude Code"));
  assert.equal(found.length, 2, found.join("\n"));
  assert.match(found[0], /1 Kataster rule\(s\) do not take effect because of your `Bash\(gh issue \*\)` deny .*will be blocked/);
  assert.match(found[1], /because of your `Bash\(git log:\*\)` ask .*will ask for approval/);

  // A deny in the local settings counts too; a bare `Bash` deny takes every rule.
  const local = repo({ ".claude/settings.local.json": { permissions: { deny: ["Bash"] } } });
  install(local);
  assert.match(warnings(local).join("\n"), new RegExp(`${ALLOW.length} Kataster rule\\(s\\) .*\`Bash\` deny .*settings\\.local\\.json`));
});

test("Claude Code: a settings.json that is not plain JSON is never overwritten – its deny rules survive", () => {
  for (const text of [
    `{\n  // never delete issues\n  "permissions": { "deny": ["Bash(gh issue delete *)"] }\n}\n`,
    `{ "permissions": { "deny": ["Bash(gh issue delete *)"], } }\n`,
    `\uFEFF{ "permissions": { "deny": ["Bash(gh issue delete *)"] } }\n`,
    `["not an object"]\n`,
  ]) {
    const dir = repo({ ".claude/settings.json": text });
    const out = install(dir).out;
    assert.equal(read(dir, ".claude/settings.json"), text);
    assert.match(out, /settings\.json is not plain JSON and was left untouched.*NOT wired up/);
    install(dir);
    assert.equal(read(dir, ".claude/settings.json"), text);
    const doctor = run(["doctor", dir]);
    assert.equal(doctor.code, 1);
    assert.match(doctor.out, /✗ Claude Code: \.claude\/settings\.json is not plain JSON/);
  }
});

test("the pattern helpers: overlap, cover, and where a rule goes", () => {
  assert.ok(matches("git status *", "git status") && matches("git status *", "git status -s") && !matches("git status *", "git statusx"));
  assert.ok(overlaps("gh issue *", "gh * delete *") && overlaps("*--force*", "git diff *") && !overlaps("git push *main*", "git status *"));
  assert.ok(covers("*", "gh issue *") && covers("gh *", "gh issue *") && covers("gh issue *", "gh issue delete *"));
  assert.ok(!covers("gh issue delete *", "gh issue *") && !covers("gh issue *", "gh *"));
  assert.deepEqual(fileRules({ tools: { bash: false }, permission: { bash: { "x *": "ask" }, edit: "deny" }, permissions: [rule("y", "allow")] }), [
    rule("*", "deny"), rule("x *", "ask"), rule("*", "deny", "edit"), rule("y", "allow"),
  ]);
  // A deny behind an ask: Kataster's script rule goes in front of the deny – behind the ask it overrides.
  const list = [rule("*", "ask"), rule("node *", "deny")];
  const script = rule("node .claude/skills/backlog/scripts/*", "allow");
  const plan = planRules({ earlier: [], list, wanted: [script] });
  assert.deepEqual(plan.inserts, [{ index: 1, rules: [script] }]);
});
