/**
 * Monorepo detection for the installer.
 *
 * The profile needs to know which build tool drives the repository and where its workspaces are, because the
 * workflow must use that tool (`nx affected`, `turbo --filter`, `pnpm --filter`, `bazel query`) instead of
 * assuming one package at the root. This file is deliberately dependency-free – it runs before
 * `.claude/node_modules` exists. The full package graph is built later by `.claude/lib/repo.ts`.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const TOOL_MARKERS = [
  { kind: "bazel", config: ["MODULE.bazel", "WORKSPACE.bazel", "WORKSPACE"] },
  { kind: "nx", config: ["nx.json"] },
  { kind: "turbo", config: ["turbo.json"] },
  { kind: "rush", config: ["rush.json"] },
  { kind: "lerna", config: ["lerna.json"] },
  { kind: "pnpm", config: ["pnpm-workspace.yaml"] },
  { kind: "go-work", config: ["go.work"] },
  { kind: "cargo-workspace", config: ["Cargo.toml"], require: (text) => /^\s*\[workspace\]/m.test(text) },
  { kind: "gradle", config: ["settings.gradle.kts", "settings.gradle"], require: (text) => /\binclude\s*[(:]/.test(text) },
  { kind: "maven", config: ["pom.xml"], require: (text) => /<modules>/.test(text) },
];

function readText(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** The package manager that owns the lockfile, or undefined. */
export function detectPackageManager(root) {
  if (existsSync(join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(root, "yarn.lock"))) return "yarn";
  if (existsSync(join(root, "bun.lockb")) || existsSync(join(root, "bun.lock"))) return "bun";
  if (existsSync(join(root, "package-lock.json"))) return "npm";
  return undefined;
}

function findTool(root) {
  for (const tool of TOOL_MARKERS) {
    for (const name of tool.config) {
      const path = join(root, name);
      if (!existsSync(path)) continue;
      if (tool.require) {
        const text = readText(path);
        if (text === undefined || !tool.require(text)) continue;
      }
      return { kind: tool.kind, config: name };
    }
  }
  return { kind: "none", config: "" };
}

/** Workspace globs from the manifest that owns them. Never guesses from directory names. */
export function workspaceGlobs(root) {
  const out = [];
  const pkg = readJson(join(root, "package.json"));
  const declared = Array.isArray(pkg?.workspaces) ? pkg.workspaces : pkg?.workspaces?.packages;
  if (Array.isArray(declared)) out.push(...declared.filter((v) => typeof v === "string"));

  const pnpm = readText(join(root, "pnpm-workspace.yaml"));
  if (pnpm !== undefined) {
    let inPackages = false;
    for (const raw of pnpm.split("\n")) {
      const line = raw.replace(/#.*$/, "");
      if (/^packages\s*:/.test(line)) {
        inPackages = true;
        continue;
      }
      if (inPackages && /^\S/.test(line) && line.trim()) break;
      const match = /^\s*-\s*['"]?([^'"]+?)['"]?\s*$/.exec(line);
      if (inPackages && match) out.push(match[1]);
    }
  }

  const lerna = readJson(join(root, "lerna.json"));
  if (Array.isArray(lerna?.packages)) out.push(...lerna.packages.filter((v) => typeof v === "string"));

  const rush = readJson(join(root, "rush.json"));
  if (Array.isArray(rush?.projects)) {
    for (const project of rush.projects) {
      if (typeof project?.projectFolder === "string") out.push(project.projectFolder);
    }
  }

  return [...new Set(out)];
}

/**
 * What the repository uses to build and test across packages.
 * `kind` is the strongest detected tool; `manager` is the package manager from the lockfile.
 */
export function detectRepoTooling(root) {
  const tool = findTool(root);
  const workspaces = workspaceGlobs(root);
  const pkg = readJson(join(root, "package.json"));
  const declared = typeof pkg?.packageManager === "string" ? pkg.packageManager.split("@")[0] : undefined;
  const manager = detectPackageManager(root)
    ?? (["npm", "pnpm", "yarn", "bun"].includes(declared) ? declared : undefined)
    ?? (tool.kind === "pnpm" || existsSync(join(root, "pnpm-workspace.yaml")) ? "pnpm" : undefined);
  const declaredWorkspaces = Array.isArray(pkg?.workspaces)
    || (pkg?.workspaces && Array.isArray(pkg.workspaces.packages))
    || workspaces.length > 0;

  const kind = tool.kind !== "none"
    ? tool.kind
    : declaredWorkspaces
      ? "workspaces"
      : "none";

  return {
    kind,
    config: tool.config,
    workspaces,
    manager: manager ?? (pkg ? "npm" : ""),
    monorepo: kind !== "none",
  };
}
