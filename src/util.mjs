import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

export const sha = (text) => createHash("sha256").update(text).digest("hex");

export const read = (path) => readFileSync(path, "utf8");
export const exists = (path) => existsSync(path);

export function write(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

export function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

export function writeJson(path, value) {
  write(path, `${JSON.stringify(value, null, 2)}\n`);
}

export const toPosix = (path) => path.split(sep).join("/");
export const relPosix = (from, to) => toPosix(relative(from, to));

export function isInside(root, path) {
  const r = resolve(root);
  const p = resolve(path);
  return p === r || p.startsWith(`${r}${sep}`);
}

export function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/** Minimal JSONC → JSON: strips comments and trailing commas, respecting strings. */
export function stripJsonc(text) {
  let out = "";
  let inString = false;
  let quote = "";
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    const next = text[i + 1];
    if (inString) {
      out += c;
      if (c === "\\") {
        out += next ?? "";
        i += 1;
      } else if (c === quote) {
        inString = false;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      inString = true;
      quote = c;
      out += c;
      continue;
    }
    if (c === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      out += "\n";
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 1;
      continue;
    }
    out += c;
  }
  return out.replace(/,\s*([}\]])/g, "$1");
}

export function parseJsonc(text) {
  try {
    return JSON.parse(stripJsonc(text));
  } catch {
    return undefined;
  }
}

/** Replaces (or appends) a marker-delimited block. Idempotent. */
export function upsertBlock(text, block, { begin = "<!-- kataster:begin -->", end = "<!-- kataster:end -->" } = {}) {
  const start = text.indexOf(begin);
  const stop = text.indexOf(end);
  if (start !== -1 && stop !== -1 && stop > start) {
    return `${text.slice(0, start)}${block}${text.slice(stop + end.length)}`.replace(/\n{3,}/g, "\n\n");
  }
  const trimmed = text.trimEnd();
  return `${trimmed}${trimmed ? "\n\n" : ""}${block}\n`;
}

export function mergeUnique(base = [], add = []) {
  return [...new Set([...base, ...add])];
}

export const packageRoot = (importMetaUrl) => resolve(dirname(new URL(importMetaUrl).pathname), "..");

export function relativeDisplay(root, path) {
  const r = relPosix(root, path);
  return r.startsWith("../") ? path : r;
}

export { join };
