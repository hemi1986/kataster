/**
 * A small, quote-aware view of a shell command line for the guards. Not a shell parser: it knows just enough to tell
 * the command that runs from text that is only passed along – a quoted argument, an `echo`, a commit message or a
 * heredoc body.
 *
 * Every simple command (split at `;`, `&&`, `||`, `|`, `&` and newlines outside quotes) becomes a segment with
 *   - `masked`: the words without heredoc bodies and without quoted text that contains whitespace – what the command
 *     itself says (a quoted single token such as `"--prod"` stays),
 *   - `raw`: the words with quotes removed plus heredoc bodies – everything the command receives,
 *   - `head`: the executable, after env assignments and wrappers such as `sudo` or `npx`.
 * Code that does run is a segment of its own: `$(…)` and backticks (outside single quotes), the script of
 * `sh|bash|zsh -c "…"` and the arguments of `eval`.
 */

export interface Segment {
  masked: string;
  raw: string;
  head: string;
}

interface Word {
  value: string;
  masked: string;
}

const WRAPPERS = new Set(["sudo", "env", "time", "nohup", "command", "exec", "npx", "bunx", "doas"]);
const RUNNERS = new Set(["pnpm", "yarn", "npm", "bun"]);
const RUNNER_SUBCOMMANDS = new Set(["dlx", "exec", "x"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const MAX_DEPTH = 5;

/** A quoted single token (`"--prod"`, `'+main'`) still counts as part of the command; quoted prose does not. */
const quotedMask = (content: string): string => (/\s/.test(content) || content.includes("$(") || content.includes("`") ? "" : content);

/** Reads `$( … )` starting after the opening parenthesis; returns the inner text and the index after `)`. */
function readSubstitution(s: string, start: number): [string, number] {
  let depth = 1;
  let quote: string | null = null;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === "\\" && quote === '"') i++;
      else if (c === quote) quote = null;
    } else if (c === "'" || c === '"') {
      quote = c;
    } else if (c === "\\") {
      i++;
    } else if (c === "(") {
      depth++;
    } else if (c === ")" && --depth === 0) {
      return [s.slice(start, i), i + 1];
    }
  }
  return [s.slice(start), s.length];
}

/** Splits a command line into the words of each simple command; collects heredoc bodies and executed substitutions. */
function lex(cmd: string): { commands: { words: Word[]; heredocs: string[] }[]; executed: string[] } {
  const commands: { words: Word[]; heredocs: string[] }[] = [];
  const executed: string[] = [];
  let words: Word[] = [];
  let heredocs: string[] = [];
  let word: Word | null = null;
  const pendingHeredocs: string[] = [];

  const addWord = () => {
    if (word) words.push(word);
    word = null;
  };
  const endCommand = () => {
    addWord();
    if (words.length || heredocs.length) commands.push({ words, heredocs });
    words = [];
    heredocs = [];
  };
  const append = (value: string, masked: string) => {
    word ??= { value: "", masked: "" };
    word.value += value;
    word.masked += masked;
  };

  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    const next = cmd[i + 1];

    if (c === "\n") {
      // Heredoc bodies start on the next line and end at their delimiter; they belong to the command that opened them.
      let pos = i + 1;
      for (const tag of pendingHeredocs.splice(0)) {
        const body: string[] = [];
        while (pos < cmd.length) {
          const end = cmd.indexOf("\n", pos);
          const line = cmd.slice(pos, end === -1 ? cmd.length : end);
          pos = end === -1 ? cmd.length : end + 1;
          if (line.replace(/^\t+/, "").trim() === tag) break;
          body.push(line);
        }
        heredocs.push(body.join("\n"));
      }
      i = pos - 1;
      endCommand();
      continue;
    }
    if (c === " " || c === "\t") {
      addWord();
      continue;
    }
    if (c === "#" && !word) {
      while (i + 1 < cmd.length && cmd[i + 1] !== "\n") i++;
      continue;
    }
    if (c === ";" || c === "|" || (c === "&" && cmd[i - 1] !== ">" && cmd[i - 1] !== "<" && next !== ">")) {
      if ((c === "|" || c === "&") && next === c) i++;
      endCommand();
      continue;
    }
    if (c === "<" && next === "<" && cmd[i + 2] !== "<") {
      addWord();
      const m = /^<<-?\s*(['"]?)([A-Za-z_][\w-]*)\1/.exec(cmd.slice(i));
      if (m) {
        pendingHeredocs.push(m[2]);
        i += m[0].length - 1;
        continue;
      }
    }
    if (c === "\\") {
      append(next ?? "", next ?? "");
      i++;
      continue;
    }
    if (c === "'") {
      const end = cmd.indexOf("'", i + 1);
      const content = cmd.slice(i + 1, end === -1 ? cmd.length : end);
      append(content, quotedMask(content));
      i = end === -1 ? cmd.length : end;
      continue;
    }
    if (c === '"') {
      let content = "";
      let j = i + 1;
      for (; j < cmd.length && cmd[j] !== '"'; j++) {
        if (cmd[j] === "\\" && j + 1 < cmd.length) {
          content += cmd[++j];
        } else if (cmd[j] === "$" && cmd[j + 1] === "(") {
          const [inner, after] = readSubstitution(cmd, j + 2);
          executed.push(inner);
          content += `$(${inner})`;
          j = after - 1;
        } else if (cmd[j] === "`") {
          const end = cmd.indexOf("`", j + 1);
          const inner = cmd.slice(j + 1, end === -1 ? cmd.length : end);
          executed.push(inner);
          content += `\`${inner}\``;
          j = end === -1 ? cmd.length : end;
        } else {
          content += cmd[j];
        }
      }
      append(content, quotedMask(content));
      i = j;
      continue;
    }
    if (c === "$" && next === "(") {
      const [inner, after] = readSubstitution(cmd, i + 2);
      executed.push(inner);
      append(`$(${inner})`, "");
      i = after - 1;
      continue;
    }
    if (c === "`") {
      const end = cmd.indexOf("`", i + 1);
      const inner = cmd.slice(i + 1, end === -1 ? cmd.length : end);
      executed.push(inner);
      append(`\`${inner}\``, "");
      i = end === -1 ? cmd.length : end;
      continue;
    }
    append(c, c);
  }
  endCommand();
  return { commands, executed };
}

/** Index of the executable: after `VAR=value` assignments and wrappers (`sudo`, `npx`, `pnpm dlx`, …). */
function headIndex(words: Word[]): number {
  let i = 0;
  while (i < words.length) {
    const w = words[i].value;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) i++;
    else if (WRAPPERS.has(w)) i++;
    else if (w.startsWith("-") && i > 0 && WRAPPERS.has(words[i - 1].value)) i++;
    else if (RUNNERS.has(w) && RUNNER_SUBCOMMANDS.has(words[i + 1]?.value ?? "")) i += 2;
    else break;
  }
  return i;
}

export function segments(cmd: string, depth = 0): Segment[] {
  if (depth > MAX_DEPTH) return [];
  const { commands, executed } = lex(cmd);
  const out: Segment[] = [];
  for (const { words, heredocs } of commands) {
    const h = headIndex(words);
    const head = (words[h]?.value ?? "").split("/").pop() ?? "";
    out.push({
      head,
      masked: words.map((w) => w.masked).filter(Boolean).join(" "),
      raw: [...words.map((w) => w.value), ...heredocs].join(" "),
    });
    // Scripts that run: `bash -c "<script>"` (also `-lc`, `-ec`, …) and `eval <args>`.
    for (let i = h; i < words.length; i++) {
      const name = words[i].value.split("/").pop() ?? "";
      if (SHELLS.has(name)) {
        const flag = words.slice(i + 1).findIndex((w) => /^-[A-Za-z]*c[A-Za-z]*$/.test(w.value));
        const script = flag >= 0 ? words[i + 1 + flag + 1] : undefined;
        if (script) out.push(...segments(script.value, depth + 1));
      }
      if (name === "eval") out.push(...segments(words.slice(i + 1).map((w) => w.value).join(" "), depth + 1));
    }
  }
  for (const inner of executed) out.push(...segments(inner, depth + 1));
  return out;
}
