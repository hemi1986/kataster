/**
 * Minimal JSONC editor: adds properties and array items to an existing JSONC text and leaves every other byte –
 * comments, blank lines, key order, indentation – where it was. No dependency; covers what the installer merges
 * (objects, arrays, strings, numbers, literals, `//` and `/* *\/` comments, trailing commas).
 */

/** Parses JSONC into a tree of `{ type, offset, end, value?, children? }`; a property is `{ key, keyOffset, value }`. */
export function parseTree(text) {
  let i = 0;

  const fail = (what) => {
    throw new SyntaxError(`JSONC: ${what} at offset ${i}`);
  };

  function skip() {
    for (;;) {
      while (i < text.length && /\s/.test(text[i])) i += 1;
      if (text.startsWith("//", i)) {
        while (i < text.length && text[i] !== "\n") i += 1;
      } else if (text.startsWith("/*", i)) {
        const close = text.indexOf("*/", i + 2);
        if (close === -1) fail("unterminated comment");
        i = close + 2;
      } else {
        return;
      }
    }
  }

  function string() {
    const start = i;
    i += 1;
    while (i < text.length && text[i] !== '"') {
      if (text[i] === "\n") fail("newline in string");
      i += text[i] === "\\" ? 2 : 1;
    }
    if (i >= text.length) fail("unterminated string");
    i += 1;
    return { type: "string", offset: start, end: i, value: JSON.parse(text.slice(start, i)) };
  }

  function value() {
    skip();
    const c = text[i];
    if (c === "{") return container("object", "}");
    if (c === "[") return container("array", "]");
    if (c === '"') return string();
    const literal = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i));
    if (!literal) fail("unexpected character");
    const start = i;
    i += literal[0].length;
    return { type: "literal", offset: start, end: i, value: JSON.parse(literal[0]) };
  }

  function container(type, close) {
    const node = { type, offset: i, end: -1, children: [] };
    i += 1;
    for (;;) {
      skip();
      if (text[i] === close) break;
      if (type === "object") {
        if (text[i] !== '"') fail("expected a key");
        const key = string();
        skip();
        if (text[i] !== ":") fail("expected ':'");
        i += 1;
        node.children.push({ key: key.value, keyOffset: key.offset, value: value() });
      } else {
        node.children.push(value());
      }
      skip();
      if (text[i] === ",") {
        i += 1;
        continue;
      }
      if (text[i] !== close) fail(`expected ',' or '${close}'`);
    }
    i += 1;
    node.end = i;
    return node;
  }

  const root = value();
  skip();
  if (i !== text.length) fail("trailing content");
  return root;
}

/** The node at `path` (keys and indexes), or undefined. */
export function findNode(root, path) {
  let node = root;
  for (const step of path) {
    if (!node) return undefined;
    if (node.type === "object") node = node.children.find((p) => p.key === step)?.value;
    else if (node.type === "array" && typeof step === "number") node = node.children[step];
    else return undefined;
  }
  return node;
}

/** Evaluates a node back to a plain value. */
export function nodeValue(node) {
  if (node.type === "object") return Object.fromEntries(node.children.map((p) => [p.key, nodeValue(p.value)]));
  if (node.type === "array") return node.children.map(nodeValue);
  return node.value;
}

const lineStart = (text, offset) => text.lastIndexOf("\n", offset - 1) + 1;
const indentAt = (text, offset) => /^[ \t]*/.exec(text.slice(lineStart(text, offset)))[0];

/** The file's indentation unit: the first indented line, else two spaces. */
function indentUnit(text) {
  return /\n([ \t]+)\S/.exec(text)?.[1] ?? "  ";
}

/** One-line form with spaces after `,` and `:`, the way a hand-written `{ "action": "shell", … }` looks. */
export function inline(value) {
  if (Array.isArray(value)) return `[${value.map(inline).join(", ")}]`;
  if (value && typeof value === "object") {
    const members = Object.entries(value).map(([k, v]) => `${JSON.stringify(k)}: ${inline(v)}`);
    return members.length ? `{ ${members.join(", ")} }` : "{}";
  }
  return JSON.stringify(value);
}

/** Serializes `value` for a position whose line is indented by `indent`; `null` writes it on one line. */
function render(value, indent, unit) {
  if (indent === null) return inline(value);
  return JSON.stringify(value, null, unit).replaceAll("\n", `\n${indent}`);
}

/**
 * Inserts `entries` (strings ready to place) as the last members of `node`. Multi-line containers get one entry per
 * line at the indentation of the existing members; a comment after the last member stays on its line.
 */
function insertLast(text, node, entries, unit) {
  const last = node.children.at(-1);
  const closeAt = node.end - 1;
  if (!last) {
    const outer = indentAt(text, node.offset);
    const inner = `${outer}${unit}`;
    const body = entries.map((e) => `${inner}${e(inner)}`).join(",\n");
    return `${text.slice(0, node.offset + 1)}\n${body}\n${outer}${text.slice(closeAt)}`;
  }
  // An object's member is a property `{ key, keyOffset, value }`, an array's a node.
  const lastEnd = node.type === "object" ? last.value.end : last.end;
  const lastStart = node.type === "object" ? last.keyOffset : last.offset;
  // A trailing comma after the last member is kept; the new members follow it.
  let after = lastEnd;
  while (after < closeAt && /[ \t]/.test(text[after])) after += 1;
  const trailingComma = text[after] === ",";
  const commaEnd = trailingComma ? after + 1 : lastEnd;
  const multiline = text.slice(lastEnd, closeAt).includes("\n") || text.slice(node.offset, lastStart).includes("\n");
  if (!multiline) {
    const body = entries.map((e) => e(null)).join(", ");
    return trailingComma
      ? `${text.slice(0, commaEnd)} ${body}${text.slice(commaEnd)}`
      : `${text.slice(0, lastEnd)}, ${body}${text.slice(lastEnd)}`;
  }
  const indent = indentAt(text, lastStart);
  // Members written on one line each (`{ "action": …, "effect": "allow" }`) get company in the same style.
  const lastInline = "}]".includes(text[lastEnd - 1]) && !text.slice(lastStart, lastEnd).includes("\n");
  const body = entries.map((e) => `\n${indent}${e(lastInline ? null : indent)}`).join(",");
  // Place the new members after the rest of the last member's line when it holds only a comment, else right after it.
  const newline = text.indexOf("\n", commaEnd);
  const rest = newline === -1 || newline > closeAt ? "" : text.slice(commaEnd, newline);
  const insertAt = newline !== -1 && newline < closeAt && /^\s*(\/\/.*)?$/.test(rest) ? newline : commaEnd;
  const head = trailingComma ? text.slice(0, insertAt) : `${text.slice(0, lastEnd)},${text.slice(lastEnd, insertAt)}`;
  return `${head}${body}${trailingComma ? "," : ""}${text.slice(insertAt)}`;
}

/**
 * Adds `key: value` to the object at `path` when the key is missing. Returns the text unchanged when the key exists
 * or the path does not lead to an object.
 */
export function addProperty(text, path, key, value) {
  const node = findNode(parseTree(text), path);
  if (node?.type !== "object" || node.children.some((p) => p.key === key)) return text;
  const unit = indentUnit(text);
  return insertLast(text, node, [(indent) => `${JSON.stringify(key)}: ${render(value, indent, unit)}`], unit);
}

/**
 * Inserts `items` in front of the entry at `index` of the array at `path` (past the end: appends). The comments in
 * front of that entry stay with it.
 */
export function insertItems(text, path, index, items) {
  if (items.length === 0) return text;
  const node = findNode(parseTree(text), path);
  if (node?.type !== "array") return text;
  if (index >= node.children.length) return appendItems(text, path, items);
  const target = node.children[index];
  const before = text.slice(node.offset, target.offset);
  if (!before.includes("\n")) {
    return `${text.slice(0, target.offset)}${items.map(inline).join(", ")}, ${text.slice(target.offset)}`;
  }
  // Behind the previous entry's comma (or the opening bracket) and a comment on that line.
  let anchor = node.offset + 1;
  if (index > 0) {
    anchor = node.children[index - 1].end;
    while (/[ \t]/.test(text[anchor])) anchor += 1;
    if (text[anchor] === ",") anchor += 1;
  }
  const newline = text.indexOf("\n", anchor);
  if (newline !== -1 && newline < target.offset && /^\s*(\/\/.*)?$/.test(text.slice(anchor, newline))) anchor = newline;
  const indent = indentAt(text, target.offset);
  const oneLine = "}]".includes(text[target.end - 1]) && !text.slice(target.offset, target.end).includes("\n");
  const unit = indentUnit(text);
  const body = items.map((item) => `\n${indent}${render(item, oneLine ? null : indent, unit)},`).join("");
  return `${text.slice(0, anchor)}${body}${text.slice(anchor)}`;
}

/** Replaces the value at `path` with `source`, a text that is already JSON. */
export function replaceValue(text, path, source) {
  const node = findNode(parseTree(text), path);
  return node ? `${text.slice(0, node.offset)}${source}${text.slice(node.end)}` : text;
}

/** Appends `items` to the array at `path`. Returns the text unchanged when there is nothing to add or no array. */
export function appendItems(text, path, items) {
  if (items.length === 0) return text;
  const node = findNode(parseTree(text), path);
  if (node?.type !== "array") return text;
  const unit = indentUnit(text);
  return insertLast(text, node, items.map((item) => (indent) => render(item, indent, unit)), unit);
}
