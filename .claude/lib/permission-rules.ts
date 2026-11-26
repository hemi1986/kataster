/**
 * The project's and the user's `deny` and `ask` rules for shell commands, as far as a hook can read them – for one
 * question: would rewriting a command take it out of such a rule? Both harnesses check their permission rules
 * against the command **after** a hook rewrote it, so a rule that names the command exactly (`… marathon-state.ts
 * finish`) would no longer match once `--caller` is appended. `hooks/metrics.ts` then leaves the command alone and
 * the rule applies.
 *
 * Read: Claude Code's managed, user, project and local settings; OpenCode's global config and every config from the
 * top of the repository down to the project, agent rules in them included. Rules given on the command line are not
 * visible to a hook.
 *
 * Built-ins only: the PreToolUse path must work before `npm install --prefix .claude`.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { segments } from "./shell.ts";

/** `*` is any text, `?` one character, a trailing ` *` is optional – as both harnesses read a rule. */
export function matchesRule(pattern: string, text: string): boolean {
  let source = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  if (source.endsWith(" .*")) source = `${source.slice(0, -3)}( .*)?`;
  return new RegExp(`^${source}$`, "s").test(text);
}

/** JSON with comments and trailing commas. */
function readJsonc(path: string): any {
  try {
    const text = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
    // Strings first, so that `//` inside one is not taken for a comment.
    const bare = text.replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_, str) => str ?? "");
    return JSON.parse(bare.replace(/("(?:\\.|[^"\\])*")|,(\s*[}\]])/g, (_, str, close) => str ?? close));
  } catch {
    return undefined;
  }
}

function claudePatterns(root: string): string[] {
  const files = [
    "/etc/claude-code/managed-settings.json",
    join(homedir(), ".claude", "settings.json"),
    join(root, ".claude", "settings.json"),
    join(root, ".claude", "settings.local.json"),
  ];
  const out: string[] = [];
  for (const file of files) {
    const permissions = existsSync(file) ? readJsonc(file)?.permissions : undefined;
    for (const list of [permissions?.deny, permissions?.ask]) {
      for (const entry of Array.isArray(list) ? list : []) {
        const m = /^Bash\((.*)\)$/s.exec(String(entry));
        if (m) out.push(m[1].replace(/:\*$/, " *"));
      }
    }
  }
  return out;
}

/** Every restricting shell rule of one OpenCode config: the list, the older `permission` key, agent rules. */
function configPatterns(config: any): string[] {
  const out: string[] = [];
  const list = (rules: unknown): void => {
    for (const r of Array.isArray(rules) ? rules : []) {
      if (r && r.effect !== "allow" && typeof r.resource === "string" && matchesRule(String(r.action), "shell")) out.push(r.resource);
    }
  };
  const legacy = (permission: any): void => {
    for (const key of ["bash", "shell", "*"]) {
      const value = permission?.[key];
      if (value && typeof value === "object") for (const [resource, effect] of Object.entries(value)) if (effect !== "allow") out.push(resource);
    }
  };
  list(config?.permissions);
  legacy(config?.permission);
  for (const agents of [config?.agents, config?.agent]) {
    for (const agent of Object.values<any>(agents && typeof agents === "object" ? agents : {})) {
      list(agent?.permissions);
      legacy(agent?.permission);
    }
  }
  return out;
}

function opencodePatterns(root: string): string[] {
  const global = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode");
  const files = [join(global, "opencode.json"), join(global, "opencode.jsonc")];
  for (let dir = root; ; dir = dirname(dir)) {
    for (const name of ["opencode.json", "opencode.jsonc", ".opencode/opencode.json", ".opencode/opencode.jsonc"]) files.push(join(dir, name));
    if (existsSync(join(dir, ".git")) || dirname(dir) === dir) break;
  }
  return files.filter((f) => existsSync(f)).flatMap((f) => configPatterns(readJsonc(f)));
}

/** The command as a whole and each of its simple commands, with and without leading `VAR=value`. */
function forms(command: string): string[] {
  const parts = [command.trim(), ...segments(command).map((s) => s.raw)];
  return parts.flatMap((p) => [p, p.replace(/^(?:[A-Za-z_]\w*=\S*\s+)+/, "")]);
}

/** The first `deny` or `ask` rule that matches the command as written but not as `rewritten`, or null. */
export function ruleLostByRewrite(harness: "claude-code" | "opencode", root: string, command: string, rewritten: string): string | null {
  const patterns = harness === "opencode" ? opencodePatterns(root) : claudePatterns(root);
  if (!patterns.length) return null;
  const before = forms(command);
  const after = forms(rewritten);
  return patterns.find((p) => before.some((text, i) => matchesRule(p, text) && !matchesRule(p, after[i] ?? ""))) ?? null;
}
