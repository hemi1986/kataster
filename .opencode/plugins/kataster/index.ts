/**
 * OpenCode adapter for the Kataster workflow.
 *
 * The actual logic lives in `.claude/hooks/*.ts` (plain Node, shared with Claude Code).
 * This plugin only translates OpenCode's hook events into the JSON those scripts read
 * on stdin and their exit codes back into OpenCode behaviour:
 *
 *   SessionStart   -> event `session.created`          -> instructions entry
 *   PreToolUse     -> tool hook `execute.before`        -> throw = block
 *   PostToolUse    -> tool hook `execute.after`         -> append text to the result
 *   Stop           -> session hook `experimental.idle`  -> synthetic message once
 *
 * OpenCode also has no path-scoped rules: on every read or write, matching `.claude/rules/*.md` files are
 * attached as keyed instruction entries (`path-rules.ts`), so both harnesses see the same rules.
 *
 * The per-agent path guard is not wired here: it is expressed as `edit` permissions in
 * `.opencode/agents/*.md`, which is the native OpenCode equivalent.
 */
import { Plugin } from "@opencode/plugin";
import { spawn } from "node:child_process";
import { join } from "node:path";

type HookResult = { code: number; stdout: string; stderr: string };

/** Claude tool names the hook scripts switch on. */
const TOOL_NAME: Record<string, string> = {
  write: "Write",
  edit: "Edit",
  patch: "MultiEdit",
  shell: "Bash",
};

function pick(input: unknown, ...names: string[]): unknown {
  const obj = input as Record<string, unknown> | undefined;
  for (const name of names) if (obj?.[name] !== undefined) return obj[name];
  return undefined;
}

/** Map an OpenCode tool input onto the `tool_input` shape the Claude hooks expect. */
function claudeInput(tool: string, input: unknown): Record<string, unknown> {
  if (tool === "shell") return { command: pick(input, "command") ?? "" };

  const file_path = pick(input, "filePath", "file_path", "path", "file");
  if (tool === "write") return { file_path, content: pick(input, "content") };
  if (tool === "edit")
    return {
      file_path,
      old_string: pick(input, "oldString", "old_string"),
      new_string: pick(input, "newString", "new_string"),
      replace_all: pick(input, "replaceAll", "replace_all"),
    };
  // `patch` carries no old/new strings; the path alone is enough for the guards.
  return { file_path };
}

function additionalContext(stdout: string): string | undefined {
  try {
    return JSON.parse(stdout)?.hookSpecificOutput?.additionalContext;
  } catch {
    return undefined;
  }
}

/** Files a tool call touches. `patch` carries a patch text instead of one path. */
function toolPaths(tool: string, input: unknown): string[] {
  if (tool === "patch") {
    const text = String(pick(input, "patchText", "patch_text", "patch") ?? "");
    const out: string[] = [];
    for (const line of text.split("\n")) {
      const match = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/.exec(line) ?? /^\*\*\* Move to: (.+)$/.exec(line);
      if (match) out.push(match[1].trim());
    }
    return [...new Set(out)];
  }
  const path = pick(input, "filePath", "file_path", "path", "file");
  return typeof path === "string" && path ? [path] : [];
}

/** Path-scoped rules returned by `.claude/hooks/path-rules.ts`. */
function parseRules(stdout: string): { key: string; value: string }[] {
  try {
    const data = JSON.parse(stdout.trim()) as { rules?: unknown };
    if (!Array.isArray(data.rules)) return [];
    return data.rules.filter(
      (rule): rule is { key: string; value: string } =>
        rule !== null &&
        typeof rule === "object" &&
        typeof (rule as { key?: unknown }).key === "string" &&
        typeof (rule as { value?: unknown }).value === "string",
    );
  } catch {
    return [];
  }
}

/** Append feedback to a successful tool result so the model sees it. */
function appendText(result: unknown, text: string): unknown {
  const res = result as { content?: unknown } | undefined;
  const content = res?.content;
  if (typeof content === "string") return { ...res, content: `${content}\n\n${text}` };
  const list = Array.isArray(content) ? content : [];
  return { ...res, content: [...list, { type: "text", text }] };
}

export default Plugin.define({
  id: "kataster",
  async setup(ctx) {
    const root = ctx.location.directory;

    /** Run one hook script with a Claude-shaped payload on stdin. Never throws. */
    function run(script: string, payload: unknown, timeout = 120_000): Promise<HookResult> {
      return new Promise((resolve) => {
        // The plugin itself runs inside OpenCode's bundled Bun; the hooks are plain
        // Node scripts (type stripping), so run them with the project's Node.
        const child = spawn(process.env.KATASTER_NODE ?? "node", [join(root, ".claude", "hooks", script)], {
          cwd: root,
          env: { ...process.env, CLAUDE_PROJECT_DIR: root },
          stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
        child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
        const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
        child.on("error", (error) => {
          clearTimeout(timer);
          resolve({ code: 1, stdout, stderr: `${stderr}${String(error)}` });
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          resolve({ code: code ?? 0, stdout, stderr });
        });
        child.stdin.end(JSON.stringify(payload));
      });
    }

    // ---- Path-scoped rules ------------------------------------------------
    // Claude Code reads `.claude/rules/` itself. OpenCode has no path-scoped rules, so the same files are
    // attached to the session when a matching file is read or written. One entry per rule, so a rule is
    // injected once per session and a later write to the same area does not repeat it.
    const rulesSeen = new Map<string, Set<string>>();
    async function injectRules(sessionID: string, tool: string, input: unknown): Promise<void> {
      const paths = toolPaths(tool, input);
      if (!paths.length) return;
      try {
        const res = await run("path-rules.ts", { paths, cwd: root }, 15_000);
        const entries = parseRules(res.stdout);
        if (!entries.length) return;
        const seen = rulesSeen.get(sessionID) ?? new Set<string>();
        rulesSeen.set(sessionID, seen);
        for (const entry of entries) {
          if (seen.has(entry.key)) continue;
          seen.add(entry.key);
          await ctx.session.instructions.entry.put({
            sessionID: sessionID as never,
            key: `kataster-rule:${entry.key}`,
            value: entry.value,
          });
        }
      } catch (error) {
        // rules are guidance – never let them break a tool result
        console.error(`[kataster] path-rules failed: ${String(error)}`);
      }
    }

    // ---- SessionStart ------------------------------------------------------
    // The hook prints what is missing and where the engineering work stands.
    // An instruction entry adds it as context without starting a model turn.
    // Child sessions (subagents) get no status block and no idle gate.
    const controller = new AbortController();
    const childSessions = new Set<string>();
    void (async () => {
      for await (const event of ctx.event.subscribe({
        types: ["session.created"],
        signal: controller.signal,
      })) {
        const data = (event as {
          data?: { sessionID?: string; parentID?: string; location?: { directory?: string } };
        }).data;
        if (!data?.sessionID || data.location?.directory !== root) continue;
        if (data.parentID) {
          childSessions.add(data.sessionID);
          continue;
        }
        const res = await run("session-start.ts", {}, 15_000);
        const text = res.stdout.trim();
        if (!text) continue;
        await ctx.session.instructions.entry.put({
          sessionID: data.sessionID as never,
          key: "kataster-status",
          value: text,
        });
      }
    })().catch((error) => {
      // a broken status check never blocks a session
      console.error(`[kataster] session-start failed: ${String(error)}`);
    });

    // ---- PreToolUse: protect-files + bash-guard ----------------------------
    await ctx.tool.hook("execute.before", async (event) => {
      const toolName = TOOL_NAME[event.tool];
      if (!toolName) return;

      const payload = {
        tool_name: toolName,
        tool_input: claudeInput(event.tool, event.input),
        cwd: root,
        session_id: event.sessionID,
        agent: event.agent,
      };

      if (toolName === "Bash") {
        const res = await run("bash-guard.ts", payload, 15_000);
        if (res.code === 2) throw new Error(res.stderr.trim() || "Blocked by bash-guard.");
        return;
      }

      const res = await run("protect-files.ts", payload, 15_000);
      if (res.code === 2) throw new Error(res.stderr.trim() || "Blocked by protect-files.");
    });

    // ---- PostToolUse: validate-docs + code-check + project checks ----------
    await ctx.tool.hook("execute.after", async (event) => {
      if (event.status !== "completed") return;

      // Path-scoped rules become session context, not tool output.
      await injectRules(event.sessionID, event.tool, event.input);

      const toolName = TOOL_NAME[event.tool];
      if (toolName !== "Write" && toolName !== "Edit" && toolName !== "MultiEdit") return;

      const payload = {
        tool_name: toolName,
        tool_input: claudeInput(event.tool, event.input),
        cwd: root,
        session_id: event.sessionID,
        agent: event.agent,
      };

      const notes: string[] = [];

      const docs = await run("validate-docs.ts", payload, 60_000);
      if (docs.code === 2) notes.push(docs.stderr.trim());
      else {
        const extra = additionalContext(docs.stdout);
        if (extra) notes.push(extra);
      }

      const code = await run("code-check.ts", payload, 120_000);
      if (code.code === 2) notes.push(code.stderr.trim());

      const project = await run("project-check.ts", payload, 120_000);
      if (project.code === 2) notes.push(project.stderr.trim());
      else {
        const extra = additionalContext(project.stdout);
        if (extra) notes.push(extra);
      }

      if (notes.length) event.result = appendText(event.result, notes.join("\n\n")) as never;
    });

    // ---- Stop: the quick gate, once per user turn -------------------------
    // `experimental.idle` runs when the session has no pending input. The first
    // red result is fed back as a synthetic message; a new user prompt re-arms it.
    const sentBack = new Set<string>();
    await ctx.session.hook("prompt", (event) => {
      sentBack.delete(event.sessionID);
    });
    await ctx.session.hook("experimental.idle", async (event) => {
      if (childSessions.has(event.sessionID)) return;
      if (sentBack.has(event.sessionID)) return;
      const res = await run("stop-gate.ts", { stop_hook_active: false, session_id: event.sessionID }, 600_000);
      if (res.code !== 2) return;
      sentBack.add(event.sessionID);
      await ctx.session.synthetic({
        sessionID: event.sessionID,
        text: res.stderr.trim(),
      });
    });

    return () => controller.abort();
  },
});
