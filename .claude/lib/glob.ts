/**
 * Repository-relative glob matching shared by the architecture rules and the slice resolver.
 * No dependencies, no project knowledge.
 */
import { sep } from "node:path";

export function toPosixPath(path: string): string {
  return path.split(sep).join("/");
}

export function globToRegExp(glob: string): RegExp {
  const pattern = toPosixPath(glob);
  let out = "^";
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        i += 1;
        if (pattern[i + 1] === "/") {
          i += 1;
          out += "(?:.*/)?";
        } else {
          out += ".*";
        }
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else {
      out += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`${out}$`);
}

export function matchesAny(path: string, patterns: string[]): boolean {
  return patterns.some((pattern) => globToRegExp(pattern).test(path));
}
