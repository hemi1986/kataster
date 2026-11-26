/**
 * What a project's own permission rules mean for Kataster's – for the installer (which must never loosen them) and
 * for `doctor` (which says what does not work because of them).
 *
 * OpenCode (measured against 2.4.1): the rules of every config file are one list and the **last** matching rule
 * wins. The files come in this order, from the repository root down to the installation:
 * `opencode.json`, `opencode.jsonc`, `.opencode/opencode.json`, `.opencode/opencode.jsonc`; inside a file the older
 * `tools` and `permission` keys come before the `permissions` list. `*` matches any text, `?` one character, and a
 * trailing ` *` is optional.
 *
 * Claude Code: `deny` wins over `ask`, `ask` over `allow`, wherever the rule stands.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { nodeValue, parseTree } from "./jsonc.mjs";
import { toPosix } from "./util.mjs";

// --------------------------------------------------------------------------
// Patterns
// --------------------------------------------------------------------------
const expand = (pattern) => (pattern.endsWith(" *") ? [pattern.slice(0, -2), pattern] : [pattern]);

/** Whether the pattern matches the text, with OpenCode's semantics (Claude Code's `*` reads the same). */
export function matches(pattern, text) {
  let source = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  if (source.endsWith(" .*")) source = `${source.slice(0, -3)}( .*)?`;
  return new RegExp(`^${source}$`, "s").test(text);
}

function memo(fn) {
  const seen = new Map();
  const go = (i, j) => {
    const key = `${i},${j}`;
    if (!seen.has(key)) seen.set(key, fn(go, i, j));
    return seen.get(key);
  };
  return go(0, 0);
}

/** Whether some text matches both patterns. */
export function overlaps(a, b) {
  return expand(a).some((x) =>
    expand(b).some((y) =>
      memo((go, i, j) => {
        if (i === x.length && j === y.length) return true;
        if (x[i] === "*") return go(i + 1, j) || (j < y.length && go(i, j + 1));
        if (y[j] === "*") return go(i, j + 1) || (i < x.length && go(i + 1, j));
        if (i >= x.length || j >= y.length) return false;
        return (x[i] === y[j] || x[i] === "?" || y[j] === "?") && go(i + 1, j + 1);
      }),
    ),
  );
}

/** Whether every text `inner` matches is matched by `outer` as well. */
export function covers(outer, inner) {
  return expand(inner).every((y) =>
    expand(outer).some((x) =>
      // `inner`'s own wildcards are opaque here: only a wildcard of `outer` can stand for them.
      memo((go, i, j) => {
        if (i === x.length) return j === y.length;
        if (x[i] === "*") return go(i + 1, j) || (j < y.length && go(i, j + 1));
        if (j >= y.length || y[j] === "*") return false;
        return (x[i] === "?" || (x[i] === y[j] && y[j] !== "?")) && go(i + 1, j + 1);
      }),
    ),
  );
}

// --------------------------------------------------------------------------
// OpenCode
// --------------------------------------------------------------------------
/** Kataster's own commands – the only ones a Kataster rule may take out of a project's `ask`. */
const OWN_RE = /^node \.claude\/(?:skills\/[^\s/]+\/scripts\/|hooks\/)/;
export const isOwnRule = (rule) => OWN_RE.test(rule.resource);

const forShell = (rule) => typeof rule?.resource === "string" && typeof rule.action === "string" && matches(rule.action, "shell");
const restricts = (rule) => forShell(rule) && rule.effect !== "allow";

const plain = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const toolAction = (name) => (name === "bash" ? "shell" : name);

/** The rules one config file stands for, in the order OpenCode applies them. */
export function fileRules(config) {
  const rules = [];
  for (const [name, on] of Object.entries(plain(config.tools) ? config.tools : {})) {
    rules.push({ action: toolAction(name), resource: "*", effect: on ? "allow" : "deny" });
  }
  const legacy = config.permission;
  if (typeof legacy === "string") rules.push({ action: "*", resource: "*", effect: legacy });
  else if (plain(legacy)) {
    for (const [name, value] of Object.entries(legacy)) {
      if (typeof value === "string") rules.push({ action: toolAction(name), resource: "*", effect: value });
      else if (plain(value)) {
        for (const [resource, effect] of Object.entries(value)) rules.push({ action: toolAction(name), resource, effect });
      }
    }
  }
  if (Array.isArray(config.permissions)) rules.push(...config.permissions);
  return rules;
}

/** From the top of the repository that holds `root` down to `root`; only `root` outside a repository. */
function configDirs(root) {
  const dirs = [root];
  for (let dir = root; !existsSync(join(dir, ".git")); ) {
    const up = dirname(dir);
    if (up === dir) return [root];
    dir = up;
    dirs.unshift(dir);
  }
  return dirs;
}

const CONFIG_FILES = ["opencode.json", "opencode.jsonc", ".opencode/opencode.json", ".opencode/opencode.jsonc"];

/** The file the installer writes. */
export const TARGET_CONFIG = ".opencode/opencode.jsonc";

/**
 * Every OpenCode config that applies to `root`, in the order OpenCode reads them, without the installer's own file
 * (it comes last): `{ file, config }`, with `config: null` for a file that cannot be read.
 */
export function earlierConfigs(root) {
  const out = [];
  for (const dir of configDirs(root)) {
    for (const name of CONFIG_FILES) {
      const path = join(dir, name);
      if ((dir === root && name === TARGET_CONFIG) || !existsSync(path)) continue;
      out.push({ file: toPosix(relative(root, path)), config: readConfig(readFileSync(path, "utf8")) });
    }
  }
  return out;
}

export function readConfig(text) {
  try {
    const value = nodeValue(parseTree(text.replace(/^﻿/, "")));
    return plain(value) ? value : null;
  } catch {
    return null;
  }
}

/** `{ ...rule, file }` for every rule of the configs. */
export const rulesOf = (configs) => configs.flatMap(({ file, config }) => (config ? fileRules(config).map((r) => ({ ...r, file })) : []));

/**
 * Whether allowing `ours` after the project's rule `theirs` would loosen it: any `deny` that shares a command with
 * ours; an `ask` too, unless ours only covers Kataster's own commands.
 */
const loosens = (ours, theirs) =>
  restricts(theirs) && !(theirs.effect === "ask" && isOwnRule(ours)) && overlaps(theirs.resource, ours.resource);

/**
 * Where the missing Kataster rules go so that no rule of the project loses against them.
 *   earlier – the rules that come before the installer's list (other files, the legacy keys of its file); a list
 *             entry cannot be placed before them, so a rule that would loosen one of them is left out
 *   list    – the project's `permissions` list: a rule goes in front of the first entry it would loosen, else last
 * Returns `inserts` (`{ index, rules }`, index into `list`), `appended`, and `held` (`{ rule, by, left }`: placed in
 * front of `by` or, with `left`, not added).
 */
export function planRules({ earlier, list, wanted }) {
  const key = (rule) => [rule?.action, rule?.resource, rule?.effect].join("\0");
  const have = new Set(list.map(key));
  const at = new Map();
  const appended = [];
  const held = [];
  for (const rule of wanted.filter((r) => !have.has(key(r)))) {
    const before = earlier.find((p) => loosens(rule, p));
    if (before) {
      held.push({ rule, by: before, left: true });
      continue;
    }
    const index = list.findIndex((p) => loosens(rule, p));
    if (index === -1) appended.push(rule);
    else {
      at.set(index, [...(at.get(index) ?? []), rule]);
      held.push({ rule, by: list[index], left: false });
    }
  }
  const inserts = [...at].map(([index, rules]) => ({ index, rules })).sort((a, b) => a.index - b.index);
  return { inserts, appended, held };
}

/** A project rule like `*--force*` guards a detail of any command; it does not take a Kataster rule out of work. */
const concerns = (theirs, ours) => covers(theirs.resource, ours.resource) || !theirs.resource.startsWith("*");

/**
 * Which Kataster rules do not take effect: for each of `wanted`, the restricting rules of the full list that still
 * decide some of its commands – no later `allow` covers them. Grouped by the project's rule.
 */
export function shadowed(all, wanted) {
  const groups = new Map();
  for (const ours of wanted) {
    all.forEach((theirs, i) => {
      if (!restricts(theirs) || !overlaps(theirs.resource, ours.resource) || !concerns(theirs, ours)) return;
      const lifted = all
        .slice(i + 1)
        .some((a) => forShell(a) && a.effect === "allow" && (covers(a.resource, ours.resource) || covers(a.resource, theirs.resource)));
      if (lifted) return;
      if (!groups.has(i)) groups.set(i, { by: theirs, rules: [] });
      groups.get(i).rules.push(ours);
    });
  }
  return [...groups.values()];
}

/**
 * The other direction: a project rule that a Kataster rule after it overrides. A broad rule with allows after it is
 * how an OpenCode allow list is written, so only a rule that is not simply wider than ours counts – a targeted
 * `gh issue delete *` that stands before `gh issue *` has no effect. Kataster's own commands out of an `ask` are
 * intended.
 */
export function overridden(all, wanted) {
  const ids = new Set(wanted.map((r) => [r.action, r.resource, r.effect].join("\0")));
  const out = [];
  all.forEach((theirs, i) => {
    if (!restricts(theirs)) return;
    const by = all.slice(i + 1).filter(
      (a) =>
        ids.has([a.action, a.resource, a.effect].join("\0")) &&
        loosens(a, theirs) &&
        !(covers(theirs.resource, a.resource) && !covers(a.resource, theirs.resource)),
    );
    if (by.length) out.push({ rule: theirs, by });
  });
  return out;
}

// --------------------------------------------------------------------------
// Claude Code
// --------------------------------------------------------------------------
/** The command pattern of a `Bash(…)` permission entry (`Bash` alone is every command), or null for another tool. */
export function bashPattern(entry) {
  if (entry === "Bash") return "*";
  const m = /^Bash\((.*)\)$/s.exec(entry);
  return m ? m[1].replace(/:\*$/, " *") : null;
}

/** The project's `deny` and `ask` entries that take a Kataster `allow` entry out of work, grouped by their entry. */
export function claudeShadowed(settings, allow) {
  const out = [];
  for (const { file, permissions } of settings) {
    for (const effect of ["deny", "ask"]) {
      for (const entry of permissions?.[effect] ?? []) {
        const pattern = bashPattern(entry);
        if (pattern === null) continue;
        const rules = allow.filter((a) => {
          const ours = bashPattern(a);
          return ours !== null && overlaps(pattern, ours) && concerns({ resource: pattern }, { resource: ours });
        });
        if (rules.length) out.push({ by: { resource: entry, effect, file }, rules: rules.map((a) => ({ resource: bashPattern(a) })) });
      }
    }
  }
  return out;
}

// --------------------------------------------------------------------------
// What it means for the user
// --------------------------------------------------------------------------
const CONSEQUENCES = [
  [/skills\/backlog\//, "the backlog sync (/backlog-sync)"],
  [/skills\/implement\//, "/implement (context pack, story status, verify)"],
  [/skills\/marathon\//, "/marathon (plan and run state)"],
  [/skills\/metrics\//, "the story metrics markers"],
  [/skills\/user-stories\//, "the story linter and the backlog rendering"],
  [/skills\/event-storming\//, "checking and rendering the event storming"],
  [/skills\/research\//, "/research"],
  [/skills\/adopt\//, "/adopt, the repository map and the boundary check"],
  [/^gh issue/, "`gh issue` calls the agent makes itself (the backlog scripts run `gh` inside their own process)"],
  [/^gh label/, "`gh label` calls the agent makes itself"],
  [/^git /, "the agent's `git status/diff/log` (every workflow and the reviewers)"],
];

export function consequence(rules, effect) {
  const what = [...new Set(rules.map((r) => CONSEQUENCES.find(([re]) => re.test(r.resource))?.[1] ?? r.resource))];
  const happens = effect === "ask" ? "will ask for approval (an unattended run waits there)" : "will be blocked, at least in part";
  return `${what.join("; ")} ${happens}`;
}
