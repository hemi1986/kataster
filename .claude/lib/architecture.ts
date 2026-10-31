/**
 * Architecture boundaries and project checks.
 *
 * Two files are the source of truth:
 *   - `docs/architecture/boundaries.yaml` – allowed/forbidden dependency edges between packages
 *   - `docs/engineering/checks.yaml`     – which checks run at edit time and at stop/CI
 *
 * The boundary checker has two engines:
 *   - `scan`: built-in import scanner for JS/TS (no extra dependency)
 *   - `command`: run the project's own architecture check (dependency-cruiser, Nx module boundaries,
 *     ArchUnit, import-linter, Bazel, …) and ratchet its failure output
 *
 * Existing violations are frozen in `docs/architecture/boundaries.baseline.json`. Only **new** violations
 * fail, so a brownfield repository is green on day one and the rules tighten as the code is cleaned up.
 *
 * Rules are evaluated in order; the first matching `from` → `to` pair decides. No match means allow.
 * Patterns are repo-relative globs (`*`, `**`, `?`).
 *
 * Node >= 22.18, erasable TypeScript only. Runtime dependency: `yaml` (already in .claude/package.json).
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { ROOT, scanRepo, readRepoMap, type RepoMap } from "./repo.ts";

export const BOUNDARIES_FILE = join("docs", "architecture", "boundaries.yaml");
export const BASELINE_FILE = join("docs", "architecture", "boundaries.baseline.json");
export const CHECKS_FILE = join("docs", "engineering", "checks.yaml");
export const RULES_DIR = join(".claude", "rules");

export type Engine = "auto" | "scan" | "command";
export type Phase = "edit" | "stop" | "ci";

export interface BoundaryRule {
  id: string;
  from: string;
  to: string | string[];
  effect: "allow" | "deny";
  reason?: string;
}

export interface Boundaries {
  version: 1;
  engine: Engine;
  command: string;
  rules: BoundaryRule[];
}

export interface Check {
  name: string;
  command: string;
  phase: Phase;
  paths: string[];
  timeout: number;
  advisory: boolean;
}

export interface ChecksFile {
  version: 1;
  checks: Check[];
}

export interface ImportEdge {
  fromFile: string;
  fromPackage?: string;
  toFile?: string;
  toPackage?: string;
  specifier: string;
  line: number;
}

export interface Violation {
  key: string;
  rule: string;
  fromFile: string;
  fromPackage?: string;
  toFile?: string;
  toPackage?: string;
  specifier?: string;
  line?: number;
  reason?: string;
}

export interface CommandFailure {
  key: string;
  name: string;
  output: string;
}

export interface Baseline {
  version: 1;
  violations: { key: string; rule: string; fromFile: string; toFile?: string; specifier?: string }[];
  commands: { key: string; name?: string; output?: string }[];
}

export interface BoundaryResult {
  engine: Engine;
  checked: number;
  violations: Violation[];
  command?: CommandFailure;
  note?: string;
}

const CODE_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte", ".astro"]);
const SCAN_IGNORED = new Set([
  "node_modules", "dist", "build", "out", "coverage", ".next", ".nuxt", ".svelte-kit", ".turbo", ".nx",
  "vendor", "target", ".git", ".claude", ".opencode", ".kataster", "docs", ".github", "__pycache__",
  ".venv", "venv", "tmp", "temp",
]);
const MAX_SCAN_FILES = 5000;

const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const toPosix = (p: string): string => p.split(sep).join("/");

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** Project-relative POSIX path. */
export function relPath(root: string, path: string): string {
  return toPosix(relative(resolve(root), resolve(root, path)));
}

export function inside(root: string, path: string): boolean {
  const r = relPath(root, path);
  return r !== "" && !r.startsWith("..") && !isAbsolute(r);
}

// --------------------------------------------------------------------------
// Globs
// --------------------------------------------------------------------------
export function globToRegExp(glob: string): RegExp {
  const pattern = toPosix(glob);
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

// --------------------------------------------------------------------------
// Configuration
// --------------------------------------------------------------------------
function parseBoundaries(data: unknown, where: string): Boundaries {
  if (!isObject(data)) throw new Error(`${where}: root must be an object`);
  const engine = data.engine === "scan" || data.engine === "command" ? data.engine : "auto";
  const rules: BoundaryRule[] = [];
  if (Array.isArray(data.rules)) {
    data.rules.forEach((raw, index) => {
      if (!isObject(raw)) throw new Error(`${where}: rules[${index}] must be an object`);
      const id = typeof raw.id === "string" ? raw.id : `rule-${index + 1}`;
      const from = raw.from;
      const to = raw.to;
      const effect = raw.effect;
      if (typeof from !== "string" || !from) throw new Error(`${where}: ${id}.from is missing`);
      if (!(typeof to === "string" || Array.isArray(to)) || (Array.isArray(to) && !to.length)) {
        throw new Error(`${where}: ${id}.to is missing`);
      }
      if (effect !== "allow" && effect !== "deny") throw new Error(`${where}: ${id}.effect must be allow or deny`);
      rules.push({
        id,
        from,
        to: Array.isArray(to) ? list(to) : to,
        effect,
        reason: typeof raw.reason === "string" ? raw.reason : undefined,
      });
    });
  }
  return {
    version: 1,
    engine,
    command: typeof data.command === "string" ? data.command : "",
    rules,
  };
}

export function loadBoundaries(root: string): Boundaries | undefined {
  const path = join(root, BOUNDARIES_FILE);
  const text = readText(path);
  if (text === undefined || !text.trim()) return undefined;
  return parseBoundaries(parseYaml(text), BOUNDARIES_FILE);
}

export function loadChecks(root: string): ChecksFile | undefined {
  const path = join(root, CHECKS_FILE);
  const text = readText(path);
  if (text === undefined || !text.trim()) return { version: 1, checks: [] };
  const data: unknown = parseYaml(text);
  if (!isObject(data)) throw new Error(`${CHECKS_FILE}: root must be an object`);
  const checks: Check[] = [];
  if (Array.isArray(data.checks)) {
    data.checks.forEach((raw, index) => {
      if (!isObject(raw)) throw new Error(`${CHECKS_FILE}: checks[${index}] must be an object`);
      const name = typeof raw.name === "string" ? raw.name : `check-${index + 1}`;
      if (typeof raw.command !== "string" || !raw.command.trim()) throw new Error(`${CHECKS_FILE}: ${name}.command is missing`);
      const phase: Phase = raw.phase === "stop" || raw.phase === "ci" ? raw.phase : "edit";
      checks.push({
        name,
        command: raw.command,
        phase,
        paths: typeof raw.paths === "string" ? [raw.paths] : list(raw.paths),
        timeout: typeof raw.timeout === "number" && raw.timeout > 0 ? raw.timeout : 60,
        advisory: raw.advisory === true,
      });
    });
  }
  return { version: 1, checks };
}

// --------------------------------------------------------------------------
// Defaults for --init
// --------------------------------------------------------------------------
export function defaultRules(map: RepoMap): BoundaryRule[] {
  const dirs = new Set(
    map.packages.map((p) => (p.path === "." ? "" : p.path.split("/")[0])).filter(Boolean),
  );
  const rules: BoundaryRule[] = [];
  if (dirs.has("libs")) {
    rules.push({
      id: "shared-libs-are-leaves",
      from: "libs/**",
      to: ["apps/**", "services/**"],
      effect: "deny",
      reason: "Shared libraries never import applications or services.",
    });
  }
  if (dirs.has("packages")) {
    rules.push({
      id: "shared-packages-are-leaves",
      from: "packages/**",
      to: ["apps/**", "services/**"],
      effect: "deny",
      reason: "Shared packages never import applications or services.",
    });
  }
  if (dirs.has("apps")) {
    rules.push({
      id: "apps-do-not-import-apps",
      from: "apps/**",
      to: "apps/**",
      effect: "deny",
      reason: "Applications communicate through contracts or events, not imports.",
    });
  }
  if (dirs.has("services")) {
    rules.push({
      id: "services-do-not-import-apps",
      from: "services/**",
      to: "apps/**",
      effect: "deny",
      reason: "Services communicate through contracts or events, not imports.",
    });
  }
  return rules;
}

/** Practical hints for stacks where the built-in JS/TS scanner is not the right engine. */
export function adapterHints(map: RepoMap): string[] {
  const manager = map.tooling.manager || "npm";
  switch (map.tooling.kind) {
    case "nx":
      return ["Nx detected: enable @nx/enforce-module-boundaries, then set engine: command and command: `npx nx run-many -t lint`."];
    case "turbo":
      return [`Turborepo detected: set engine: command and command: \`${manager} turbo run lint\` (or your boundary task).`];
    case "bazel":
      return ["Bazel detected: set engine: command and command: `bazel test //...`; Bazel visibility can carry the package boundaries."];
    case "go-work":
      return ["Go workspace detected: set engine: command to a script that checks `go list -deps` edges."];
    case "cargo-workspace":
      return ["Cargo workspace detected: set engine: command to a script that checks crate edges from `cargo metadata`."];
    case "gradle":
      return ["Gradle detected: add an ArchUnit test and set engine: command to `./gradlew test`."];
    case "maven":
      return ["Maven detected: add an ArchUnit test and set engine: command to `mvn test`."];
    case "pnpm":
    case "workspaces":
      return ["JS/TS scan resolves relative imports and workspace-package names; TS path aliases need engine: command."];
    default:
      return [];
  }
}

export function defaultChecks(): Check[] {
  return [
    {
      name: "architecture-boundaries",
      command: "node .claude/skills/adopt/scripts/boundary-check.ts --changed",
      phase: "edit",
      paths: ["apps/**", "libs/**", "services/**", "packages/**", "crates/**", "cmd/**", "internal/**", "src/**"],
      timeout: 30,
      advisory: false,
    },
    {
      name: "architecture-boundaries-full",
      command: "node .claude/skills/adopt/scripts/boundary-check.ts",
      phase: "stop",
      paths: [],
      timeout: 120,
      advisory: false,
    },
  ];
}

export function writeBoundaries(root: string, boundaries: Boundaries, force = false): string {
  const path = join(root, BOUNDARIES_FILE);
  if (existsSync(path) && !force) throw new Error(`${BOUNDARIES_FILE} already exists – edit it, or pass --force`);
  mkdirSync(dirname(path), { recursive: true });
  const header = [
    "# Architecture boundaries – confirmed with the user during /adopt.",
    "# Rules are evaluated in order; the first matching from -> to pair decides. No match means allow.",
    "# Patterns are repository-relative globs. engine: auto scans JS/TS imports (relative and workspace packages);",
    "# engine: command runs your own check (dependency-cruiser, Nx, Bazel, ArchUnit, import-linter) and ratchets its output.",
    "",
  ].join("\n");
  writeFileSync(path, `${header}${stringifyYaml(boundaries)}`, "utf8");
  return path;
}

export function writeChecks(root: string, checks: ChecksFile, force = false): string {
  const path = join(root, CHECKS_FILE);
  if (existsSync(path) && !force) throw new Error(`${CHECKS_FILE} already exists – edit it, or pass --force`);
  mkdirSync(dirname(path), { recursive: true });
  const header = [
    "# Project checks – what runs at edit time and at stop/CI.",
    "# `paths` narrows a check to matching changed files (globs). `advisory: true` reports without blocking.",
    "",
  ].join("\n");
  writeFileSync(path, `${header}${stringifyYaml(checks)}`, "utf8");
  return path;
}

// --------------------------------------------------------------------------
// Baseline
// --------------------------------------------------------------------------
export function emptyBaseline(): Baseline {
  return { version: 1, violations: [], commands: [] };
}

export function loadBaseline(root: string): Baseline {
  const path = join(root, BASELINE_FILE);
  const text = readText(path);
  if (text === undefined) return emptyBaseline();
  try {
    const data: unknown = JSON.parse(text);
    if (!isObject(data)) return emptyBaseline();
    return {
      version: 1,
      violations: Array.isArray(data.violations) ? data.violations.filter(isObject).map((v) => ({
        key: String(v.key ?? ""),
        rule: String(v.rule ?? ""),
        fromFile: String(v.fromFile ?? ""),
        toFile: v.toFile === undefined ? undefined : String(v.toFile),
        specifier: v.specifier === undefined ? undefined : String(v.specifier),
      })) : [],
      commands: Array.isArray(data.commands) ? data.commands.filter(isObject).map((c) => ({
        key: String(c.key ?? ""),
        name: c.name === undefined ? undefined : String(c.name),
        output: c.output === undefined ? undefined : String(c.output),
      })) : [],
    };
  } catch {
    return emptyBaseline();
  }
}

export function writeBaseline(root: string, baseline: Baseline): string {
  const path = join(root, BASELINE_FILE);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
  return path;
}

// --------------------------------------------------------------------------
// Import graph (JS/TS)
// --------------------------------------------------------------------------
const IMPORT_PATTERNS = [
  /\bimport\s+(?:[^'"]*?\s+from\s+)?["']([^"']+)["']/g,
  /\bexport\s+(?:[^'"]*?\s+from\s+)["']([^"']+)["']/g,
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
];

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (text[i] === "\n") line += 1;
  return line;
}

export function importsOf(text: string): { specifier: string; line: number }[] {
  const out: { specifier: string; line: number }[] = [];
  for (const pattern of IMPORT_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      if (match[1]) out.push({ specifier: match[1], line: lineOf(text, match.index) });
    }
  }
  return out;
}

function packageForPath(path: string, map: RepoMap): string | undefined {
  const candidates = map.packages
    .filter((p) => p.path === "." || path === p.path || path.startsWith(`${p.path}/`))
    .sort((a, b) => b.path.length - a.path.length);
  return candidates[0]?.path;
}

function resolveImport(root: string, fromFile: string, specifier: string, map: RepoMap): { file?: string; pkg?: string } {
  if (specifier.startsWith(".")) {
    const base = resolve(root, dirname(fromFile), specifier);
    const candidates = [base, ...["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].map((ext) => `${base}${ext}`)];
    for (const ext of [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]) {
      candidates.push(join(base, `index${ext}`));
    }
    const hit = candidates.find((c) => existsSync(c));
    if (!hit) return {};
    const rel = relPath(root, hit);
    if (rel.startsWith("..")) return {};
    return { file: rel, pkg: packageForPath(rel, map) };
  }

  // Workspace package import (`@acme/shared`, `@acme/shared/sub`) – resolve by package name.
  const byName = map.packages.find((p) => specifier === p.name || specifier.startsWith(`${p.name}/`));
  if (byName) return { file: byName.path, pkg: byName.path };

  // TS path alias (`@/…`) is common but project-specific; the command engine covers projects that need it.
  return {};
}

function walkCodeFiles(root: string, dirs: string[], only?: string): string[] {
  if (only) {
    const rel = relPath(root, only);
    return CODE_EXT.has(extname(rel)) && inside(root, rel) ? [rel] : [];
  }
  const out: string[] = [];
  const walk = (relDir: string): void => {
    if (out.length >= MAX_SCAN_FILES) return;
    const abs = join(root, relDir);
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= MAX_SCAN_FILES) return;
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (SCAN_IGNORED.has(entry.name) || entry.name.startsWith(".")) continue;
        walk(rel);
      } else if (entry.isFile() && CODE_EXT.has(extname(entry.name))) {
        out.push(rel);
      }
    }
  };
  for (const dir of dirs) if (dir && existsSync(join(root, dir))) walk(dir === "." ? "" : dir);
  return out;
}

export function scanImports(root: string, map: RepoMap, only?: string): ImportEdge[] {
  const dirs = map.packages.map((p) => p.path);
  const files = walkCodeFiles(root, dirs.length ? dirs : ["."], only);
  const edges: ImportEdge[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const text = readText(join(root, file));
    if (text === undefined) continue;
    for (const found of importsOf(text)) {
      const key = `${file}|${found.specifier}|${found.line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const target = resolveImport(root, file, found.specifier, map);
      edges.push({
        fromFile: file,
        fromPackage: packageForPath(file, map),
        toFile: target.file,
        toPackage: target.pkg,
        specifier: found.specifier,
        line: found.line,
      });
    }
  }
  return edges;
}

// --------------------------------------------------------------------------
// Rule evaluation
// --------------------------------------------------------------------------
function ruleMatches(rule: BoundaryRule, edge: ImportEdge): boolean {
  const fromTargets = [edge.fromFile, edge.fromPackage].filter((v): v is string => Boolean(v));
  if (!fromTargets.some((target) => globToRegExp(rule.from).test(target))) return false;
  const toPatterns = Array.isArray(rule.to) ? rule.to : [rule.to];
  const toTargets = [edge.toFile, edge.toPackage, edge.specifier].filter((v): v is string => Boolean(v));
  return toTargets.some((target) => toPatterns.some((pattern) => globToRegExp(pattern).test(target)));
}

export function violationOf(edge: ImportEdge, rule: BoundaryRule): Violation {
  return {
    key: `${rule.id}|${edge.fromFile}|${edge.toFile ?? edge.specifier}`,
    rule: rule.id,
    fromFile: edge.fromFile,
    fromPackage: edge.fromPackage,
    toFile: edge.toFile,
    toPackage: edge.toPackage,
    specifier: edge.specifier,
    line: edge.line,
    reason: rule.reason,
  };
}

export function evaluate(edges: ImportEdge[], boundaries: Boundaries): Violation[] {
  const out = new Map<string, Violation>();
  for (const edge of edges) {
    for (const rule of boundaries.rules) {
      if (!ruleMatches(rule, edge)) continue;
      if (rule.effect === "deny") {
        const violation = violationOf(edge, rule);
        if (!out.has(violation.key)) out.set(violation.key, violation);
      }
      break; // first matching rule decides
    }
  }
  return [...out.values()];
}

function commandFailure(name: string, output: string): CommandFailure {
  const normalized = output.trim().split("\n").slice(-80).join("\n");
  const key = `command|${createHash("sha256").update(`${name}\n${normalized}`).digest("hex")}`;
  return { key, name, output: normalized };
}

export function runBoundaryCommand(root: string, command: string, timeoutSeconds = 120): CommandFailure | undefined {
  const result = spawnSync(command, {
    cwd: root,
    shell: true,
    encoding: "utf8",
    timeout: timeoutSeconds * 1000,
    env: process.env,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (result.status === 0) return undefined;
  return commandFailure("architecture-command", output || `exit ${result.status ?? "?"}`);
}

export function checkBoundaries(root: string, boundaries: Boundaries, map: RepoMap, only?: string): BoundaryResult {
  const jsPath = map.packages.some((p) => p.language === "TypeScript" || p.language === "JavaScript");
  const engine: Engine = boundaries.engine === "auto" ? (jsPath ? "scan" : "command") : boundaries.engine;

  if (engine === "command") {
    if (only) {
      return { engine, checked: 0, violations: [], note: "command engine ignores --changed – run the full check at stop/CI" };
    }
    if (!boundaries.command) {
      return { engine, checked: 0, violations: [], note: "engine: command without a command – nothing checked" };
    }
    const failure = runBoundaryCommand(root, boundaries.command);
    return { engine, checked: 1, violations: [], command: failure };
  }

  const edges = scanImports(root, map, only);
  return { engine, checked: edges.length, violations: evaluate(edges, boundaries) };
}

// --------------------------------------------------------------------------
// Reporting
// --------------------------------------------------------------------------
export interface BoundaryReport {
  ok: boolean;
  engine: Engine;
  checked: number;
  violations: Violation[];
  newViolations: Violation[];
  stale: { key: string; rule: string; fromFile: string; toFile?: string; specifier?: string }[];
  command?: CommandFailure;
  commandBaselined: boolean;
  note?: string;
}

export function evaluateBaseline(result: BoundaryResult, baseline: Baseline): BoundaryReport {
  const known = new Set(baseline.violations.map((v) => v.key));
  const currentKeys = new Set(result.violations.map((v) => v.key));
  const newViolations = result.violations.filter((v) => !known.has(v.key));
  const stale = baseline.violations.filter((v) => !currentKeys.has(v.key));
  const commandBaselined = Boolean(result.command && baseline.commands.some((c) => c.key === result.command?.key));
  return {
    ok: newViolations.length === 0 && (!result.command || commandBaselined),
    engine: result.engine,
    checked: result.checked,
    violations: result.violations,
    newViolations,
    stale,
    command: result.command,
    commandBaselined,
    note: result.note,
  };
}

export function baselineFrom(result: BoundaryResult): Baseline {
  const baseline = emptyBaseline();
  for (const v of result.violations) {
    baseline.violations.push({ key: v.key, rule: v.rule, fromFile: v.fromFile, toFile: v.toFile, specifier: v.specifier });
  }
  if (result.command) baseline.commands.push({ key: result.command.key, name: result.command.name, output: result.command.output });
  return baseline;
}

export function formatViolation(v: Violation): string {
  const at = v.line ? `${v.fromFile}:${v.line}` : v.fromFile;
  const target = v.toFile ?? v.specifier ?? "?";
  return `- ${at} → ${target} [${v.rule}]${v.reason ? ` – ${v.reason}` : ""}`;
}

// --------------------------------------------------------------------------
// Rules (`.claude/rules/*.md`)
// --------------------------------------------------------------------------
export interface RuleFile {
  path: string;
  paths: string[];
  title: string;
  /** The markdown body without the frontmatter, including the `# Title` heading. */
  body: string;
}

export function parseRuleFile(path: string, root = ROOT): { rule?: RuleFile; error?: string } {
  const text = readText(path);
  if (text === undefined) return { error: "unreadable" };
  if (!text.startsWith("---\n")) return { error: "frontmatter is missing (file must start with '---')" };
  const end = text.indexOf("\n---", 4);
  if (end === -1) return { error: "frontmatter is not closed with '---'" };
  let meta: unknown;
  try {
    meta = parseYaml(text.slice(4, end)) ?? {};
  } catch (error) {
    return { error: `invalid YAML: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!isObject(meta)) return { error: "frontmatter must be an object" };
  const paths = typeof meta.paths === "string" ? [meta.paths] : list(meta.paths);
  if (!paths.length) return { error: "paths is missing or empty" };
  const body = text.slice(end + 4).replace(/^\n+/, "").trim();
  if (!body) return { error: "rule body is empty" };
  const title = /^#\s+(.+)$/m.exec(body)?.[1]?.trim() ?? "";
  if (!title) return { error: "rule body needs a '# Title' heading" };
  return { rule: { path: toPosix(relative(root, path)), paths, title, body } };
}

export function ruleFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name.endsWith(".md")) out.push(path);
    }
  };
  walk(join(root, RULES_DIR));
  return out.sort();
}

export function validateRules(root: string): { rules: RuleFile[]; errors: string[] } {
  const rules: RuleFile[] = [];
  const errors: string[] = [];
  for (const path of ruleFiles(root)) {
    const parsed = parseRuleFile(path, root);
    if (parsed.error) errors.push(`${relPath(root, path)}: ${parsed.error}`);
    else if (parsed.rule) rules.push(parsed.rule);
  }
  return { rules, errors };
}

export function writeRule(root: string, slug: string, paths: string[], title: string): string {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) throw new Error("slug must be kebab-case (a-z, 0-9, -)");
  if (!paths.length) throw new Error("at least one --paths glob is required");
  const path = join(root, RULES_DIR, `${slug}.md`);
  if (existsSync(path)) throw new Error(`${relPath(root, path)} already exists – edit it instead of overwriting`);
  mkdirSync(dirname(path), { recursive: true });
  const frontmatter = `paths:\n${paths.map((p) => `  - "${p}"`).join("\n")}`;
  const content = [
    "---",
    frontmatter,
    "---",
    "",
    `# ${title}`,
    "",
    "[OPEN] One rule per file. Write it as a checkable sentence and name where it is enforced",
    "(lint, test, `.claude/rules`, `docs/engineering/checks.yaml`). Keep it under 40 lines.",
    "",
  ].join("\n");
  writeFileSync(path, content, "utf8");
  return path;
}

// --------------------------------------------------------------------------
// Helpers used by the scripts
// --------------------------------------------------------------------------
export function rootMap(root: string): RepoMap {
  // Boundary checks do not need the Turbo graph; skip the external command so they stay fast.
  return readRepoMap(root) ?? scanRepo(root, { toolGraph: false });
}

export function defaultRoot(): string {
  return ROOT;
}
