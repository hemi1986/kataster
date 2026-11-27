/**
 * Git facts that several scripts and hooks need. No imports from the other libs, so it works before
 * `npm install --prefix .claude`.
 */
import { execFileSync } from "node:child_process";

/** Raw stdout of a git command in `root`, or null when it fails. Nothing is trimmed. */
export function gitRaw(root: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return null;
  }
}

/**
 * Project-relative paths with uncommitted changes: modified, staged, deleted and untracked files; a rename counts
 * as its new path. Parsed from `git status --porcelain -z`, where the two status columns may be blanks – trimming
 * the output or a line first shifts the path and loses the file.
 */
export function changedPaths(root: string): string[] {
  const out = gitRaw(root, ["status", "--porcelain", "-z", "--untracked-files=all"]);
  if (!out) return [];
  const parts = out.split("\0");
  const paths: string[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    const entry = parts[i];
    if (entry.length < 4) continue;
    paths.push(entry.slice(3));
    // A rename or copy is followed by its original path as an entry of its own.
    if (/[RC]/.test(entry.slice(0, 2))) i += 1;
  }
  return paths;
}

/** Collected metrics are bookkeeping, not work: they never make a tree dirty for the workflow. */
export const METRICS_DIR = "docs/stories/metrics/";
export const isMetricsPath = (path: string): boolean => path.startsWith(METRICS_DIR);

/**
 * Directories git ignores below `root`, as `root`-relative POSIX paths without a trailing slash – one
 * `git ls-files` call. A directory that still holds tracked files is not listed (git names its files instead), so
 * skipping these never hides tracked code. Null when `root` is not in a git work tree or git is missing.
 */
export function ignoredDirs(root: string): Set<string> | null {
  const out = gitRaw(root, ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"]);
  if (out === null) return null;
  const dirs = new Set<string>();
  for (const entry of out.split("\0")) {
    if (entry.endsWith("/")) dirs.add(entry.slice(0, -1));
  }
  return dirs;
}
