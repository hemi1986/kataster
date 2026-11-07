/**
 * Concept slices for repositories that are not domain-driven: layer packages, feature stems and entry points.
 *
 * The repository map says where code lives. This module adds two readings that a layered codebase needs:
 *
 *   - **role**: a package with a generic name (`services`, `repositories`, `utils`) that hosts many concepts is a
 *     layer, not a domain slice. It stays visible but is not proposed as a domain.
 *   - **slices**: clusters of files that share a concept stem or a table across layers
 *     (`api/ordersController.ts`, `services/orderService.ts`, `repositories/orderRepository.ts`).
 *
 * The resolver is evidence, not a verdict. It returns candidate files with reasons; `/adopt` confirms the scope
 * with the user. No runtime dependency, no project knowledge.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join, relative } from "node:path";
import { globToRegExp } from "./glob.ts";
import type { RepoMap, RepoPackage } from "./repo.ts";

export type PackageRole = "domain" | "layer" | "shared" | "unknown";

export interface RoleAssignment {
  role: PackageRole;
  reasons: string[];
}

export interface SliceSuggestion {
  name: string;
  terms: string[];
  tables: string[];
  files: string[];
  packages: string[];
  layers: string[];
  score: number;
  reasons: string[];
  adopted?: boolean;
  adoptedAt?: string;
}

export interface ResolvedFile {
  file: string;
  package?: string;
  layer: string;
  reasons: string[];
}

export interface ResolvedSlice {
  query: string;
  seeds: ResolvedFile[];
  files: ResolvedFile[];
  byLayer: Record<string, string[]>;
  warnings: string[];
}

export interface ResolveOptions {
  paths?: string[];
  route?: string;
  table?: string;
  event?: EventLookup;
  cluster?: string;
  term?: string;
  maxFiles?: number;
  depth?: number;
}

export interface EventLookup {
  id: string;
  terms: string[];
}

const IGNORED = new Set([
  "node_modules", "dist", "build", "out", "coverage", ".next", ".nuxt", ".svelte-kit", ".turbo", ".nx",
  "vendor", "target", ".git", ".claude", ".opencode", ".kataster", "docs", ".github", "__pycache__",
  ".venv", "venv", "tmp", "temp",
]);

const CODE_EXT = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".go", ".rs", ".py", ".java", ".kt", ".cs", ".php", ".rb",
  ".sql", ".prisma",
]);
const JS_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const MAX_FILES = 8000;

/** Words that name a layer, not a domain concept. They are stripped from file stems and package names. */
const LAYER_WORDS = new Set([
  "api", "app", "application", "adapter", "adapters", "backend", "client", "clients", "common", "component",
  "components", "config", "configuration", "controller", "controllers", "core", "dao", "database", "db", "dto",
  "dtos", "entity", "entities", "frontend", "gateway", "handler", "handlers", "helper", "helpers", "hook", "hooks",
  "infra", "infrastructure", "lib", "library", "mapper", "mappers", "middleware", "model", "models", "module",
  "modules", "page", "pages", "persistence", "plugin", "plugins", "provider", "providers", "repository",
  "repositories", "repository", "rest", "route", "routes", "router", "routers", "schema", "service", "services",
  "shared", "store", "stores", "ui", "util", "utils", "utility", "utilities", "view", "views", "web", "worker",
  "workers", "middlewares", "migration", "migrations", "seed", "seeds", "fixture", "fixtures",
]);

/** Generic package names whose *own* name says nothing about the domain. */
const GENERIC_NAME_WORDS = new Set([
  ...LAYER_WORDS, "acme", "business", "domain", "logic", "data", "access", "layer", "layers", "main", "server",
  "client", "backend", "frontend", "web", "app", "apps", "lib", "libs", "package", "packages", "tooling",
]);

const STOP_WORDS = new Set([
  "index", "main", "test", "tests", "spec", "specs", "mock", "mocks", "stub", "stubs", "type", "types", "enum",
  "enums", "const", "constants", "interface", "interfaces", "abstract", "base", "impl", "implementation", "default",
  "new", "old", "get", "set", "create", "update", "delete", "list", "find", "read", "write", "load", "save",
  "process", "handle", "run", "start", "stop", "build", "make", "check", "validate", "execute", "perform", "do",
  "with", "from", "into", "for", "and", "the", "this", "that", "object", "array", "string", "number", "boolean",
  "map",
]);

const ROOT_SEGMENTS = new Set(["src", "source", "app", "apps", "lib", "libs", "packages", "package"]);

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function singular(word: string): string {
  if (word.endsWith("ies") && word.length > 4) return `${word.slice(0, -3)}y`;
  if (word.endsWith("ses") && word.length > 4) return word.slice(0, -2);
  if (word.endsWith("s") && !word.endsWith("ss") && word.length > 3) return word.slice(0, -1);
  return word;
}

/** `orderService`, `order-service`, `OrderService` → ["order", "service"]. */
export function tokenize(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((token) => token.toLowerCase())
    .filter((token) => token.length >= 3 && !/^\d+$/.test(token) && !STOP_WORDS.has(token))
    .map(singular);
}

export function conceptStems(path: string): string[] {
  const name = basename(path, extname(path));
  return [...new Set(tokenize(name).filter((token) => !LAYER_WORDS.has(token)))];
}

function walk(dir: string, out: string[], root: string): void {
  if (out.length >= MAX_FILES) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= MAX_FILES) return;
    if (entry.isDirectory()) {
      if (IGNORED.has(entry.name) || entry.name.startsWith(".")) continue;
      walk(join(dir, entry.name), out, root);
    } else if (entry.isFile() && CODE_EXT.has(extname(entry.name))) {
      out.push(relative(root, join(dir, entry.name)).split("\\").join("/"));
    }
  }
}

/** All source and schema files in the repository, repository-relative POSIX paths. */
export function sourceFiles(root: string): string[] {
  const out: string[] = [];
  walk(root, out, root);
  return out.sort();
}

export function packageForFile(packages: RepoPackage[], file: string): RepoPackage | undefined {
  return packages
    .filter((pkg) => pkg.path === "." || file === pkg.path || file.startsWith(`${pkg.path}/`))
    .sort((a, b) => b.path.length - a.path.length)[0];
}

/** The first meaningful directory of a file: `src/services/order.ts` → `services`. */
export function layerOf(file: string): string {
  const parts = dirname(file).split("/").filter(Boolean);
  const filtered = parts.filter((part) => !ROOT_SEGMENTS.has(part));
  return (filtered.length ? filtered : parts)[0] ?? ".";
}

function packageNameTokens(pkg: RepoPackage): string[] {
  const name = pkg.name.split("/").pop() ?? pkg.name;
  return tokenize(name);
}

function filesByPackage(packages: RepoPackage[], files: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const pkg of packages) out.set(pkg.path, []);
  for (const file of files) {
    const pkg = packageForFile(packages, file);
    if (pkg) out.get(pkg.path)!.push(file);
  }
  return out;
}

/**
 * Marks packages that are layers or shared infrastructure rather than domain slices.
 *
 * The main signal is structural: a generic package name plus several concept stems, especially stems that also
 * appear in other packages. The name list is only a hint, so a non-English layer name with the same shape is
 * still detected.
 */
export function classifyPackageRoles(
  root: string,
  packages: RepoPackage[],
  files: string[] = sourceFiles(root),
): Map<string, RoleAssignment> {
  const byPackage = filesByPackage(packages, files);
  const stemsByPackage = new Map<string, Set<string>>();
  for (const pkg of packages) {
    const stems = new Set<string>();
    for (const file of byPackage.get(pkg.path) ?? []) for (const stem of conceptStems(file)) stems.add(stem);
    stemsByPackage.set(pkg.path, stems);
  }

  const packagesByStem = new Map<string, Set<string>>();
  for (const [path, stems] of stemsByPackage) {
    for (const stem of stems) packagesByStem.set(stem, new Set([...(packagesByStem.get(stem) ?? []), path]));
  }

  const out = new Map<string, RoleAssignment>();
  for (const pkg of packages) {
    const stems = stemsByPackage.get(pkg.path) ?? new Set<string>();
    const nameTokens = packageNameTokens(pkg);
    const genericName = nameTokens.length > 0 && nameTokens.every((token) => GENERIC_NAME_WORDS.has(token));
    const sharedWithOthers = [...stems].filter((stem) => (packagesByStem.get(stem)?.size ?? 0) > 1);

    if (pkg.path !== "." && genericName && (sharedWithOthers.length >= 2 || stems.size >= 3)) {
      out.set(pkg.path, {
        role: "layer",
        reasons: [
          `generic package name (${pkg.name})`,
          `${stems.size} concept stem${stems.size === 1 ? "" : "s"} in this package`,
          ...(sharedWithOthers.length ? [`${sharedWithOthers.length} shared with other packages`] : []),
        ],
      });
      continue;
    }
    if (pkg.kind === "library") {
      out.set(pkg.path, { role: "shared", reasons: ["library/shared package"] });
      continue;
    }
    out.set(pkg.path, {
      role: "domain",
      reasons: [pkg.kind === "app" || pkg.kind === "service" ? `${pkg.kind} package` : "no layer signal"],
    });
  }
  return out;
}

function tableNames(files: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const file of files) {
    if (extname(file) !== ".sql") continue;
    const text = readText(file);
    if (!text) continue;
    for (const match of text.matchAll(/\b(?:create|alter)\s+table\s+(?:if\s+not\s+exists\s+)?["'`]?([A-Za-z0-9_.]+)/gi)) {
      const raw = match[1].split(".").pop() ?? match[1];
      const stem = conceptStems(raw)[0];
      if (stem) out.set(stem, raw);
    }
  }
  return out;
}

/** Clusters files by their primary concept stem and by shared table names. */
export function clusterSlices(
  root: string,
  packages: RepoPackage[],
  files: string[] = sourceFiles(root),
): SliceSuggestion[] {
  const tables = tableNames(files);
  const byStem = new Map<string, { files: Set<string>; terms: Set<string> }>();
  const add = (stem: string, file: string, terms: string[]): void => {
    if (!stem) return;
    const entry = byStem.get(stem) ?? { files: new Set<string>(), terms: new Set<string>() };
    entry.files.add(file);
    for (const term of terms) entry.terms.add(term);
    byStem.set(stem, entry);
  };

  for (const file of files) {
    const stems = conceptStems(file);
    if (!stems.length) continue;
    add(stems[0], file, stems);
  }

  // Table evidence also pulls in files that mention the table but do not carry the stem in their file name.
  for (const [stem, table] of tables) {
    for (const file of files) {
      if (!JS_EXT.has(extname(file)) && ![".go", ".rs", ".py", ".java", ".kt", ".cs", ".php", ".rb"].includes(extname(file))) continue;
      const text = readText(file);
      if (!text || !new RegExp(`\\b${table.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text)) continue;
      add(stem, file, [stem, table]);
    }
  }

  const out: SliceSuggestion[] = [];
  for (const [stem, entry] of byStem) {
    const clusterFiles = [...entry.files].sort();
    const layers = [...new Set(clusterFiles.map(layerOf))].sort();
    const clusterPackages = [...new Set(clusterFiles.map((file) => packageForFile(packages, file)?.path ?? "?"))].sort();
    const clusterTables = tables.has(stem) ? [tables.get(stem)!] : [];
    if (layers.length < 2 && !clusterTables.length) continue;
    if (clusterFiles.length < 2 && !clusterTables.length) continue;

    const reasons: string[] = [];
    if (layers.length >= 2) reasons.push(`${layers.length} layers: ${layers.join(", ")}`);
    if (clusterTables.length) reasons.push(`table ${clusterTables.join(", ")}`);
    if (clusterPackages.length > 1) reasons.push(`${clusterPackages.length} packages`);
    reasons.push(`${clusterFiles.length} file${clusterFiles.length === 1 ? "" : "s"}`);

    out.push({
      name: stem,
      terms: [...entry.terms].sort(),
      tables: clusterTables,
      files: clusterFiles,
      packages: clusterPackages,
      layers,
      score: layers.length * 3 + clusterTables.length * 2 + Math.min(clusterFiles.length, 6) + clusterPackages.length,
      reasons,
    });
  }
  return out.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, 20);
}

const IMPORT_RE =
  /(?:import\s+(?:[^'"]*?\s+from\s+)?|export\s+[^'"]*?\s+from\s+|require\s*\(\s*|import\s*\(\s*)["']([^"']+)["']/g;

function resolveRelative(root: string, file: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const base = join(root, dirname(file), specifier);
  const candidates = [base];
  for (const ext of JS_EXT) candidates.push(`${base}${ext}`);
  for (const ext of JS_EXT) candidates.push(join(base, `index${ext}`));
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const rel = relative(root, candidate).split("\\").join("/");
    return rel;
  }
  return undefined;
}

function importGraph(root: string, files: string[]): { forward: Map<string, Set<string>>; reverse: Map<string, Set<string>> } {
  const forward = new Map<string, Set<string>>();
  const reverse = new Map<string, Set<string>>();
  const present = new Set(files);
  for (const file of files) {
    if (!JS_EXT.has(extname(file))) continue;
    const text = readText(join(root, file));
    if (!text) continue;
    for (const match of text.matchAll(IMPORT_RE)) {
      const target = resolveRelative(root, file, match[1]);
      if (!target || !present.has(target)) continue;
      forward.set(file, new Set([...(forward.get(file) ?? []), target]));
      reverse.set(target, new Set([...(reverse.get(target) ?? []), file]));
    }
  }
  return { forward, reverse };
}

function addFile(
  out: Map<string, ResolvedFile>,
  file: string,
  reason: string,
  packages: RepoPackage[],
): void {
  const existing = out.get(file);
  if (existing) {
    if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
    return;
  }
  const pkg = packageForFile(packages, file);
  out.set(file, { file, package: pkg?.path, layer: layerOf(file), reasons: [reason] });
}

/** Resolves a scope (glob, route, table, event, cluster or term) into candidate files across layers. */
export function resolveSlice(root: string, map: RepoMap, options: ResolveOptions): ResolvedSlice {
  const files = sourceFiles(root);
  const present = new Set(files);
  const seeds = new Map<string, ResolvedFile>();
  const warnings: string[] = [];
  const maxFiles = Math.max(1, options.maxFiles ?? 200);
  const depth = Math.max(0, options.depth ?? 2);

  const addSeed = (file: string, reason: string): void => {
    if (present.has(file)) addFile(seeds, file, reason, map.packages);
  };

  for (const pattern of options.paths ?? []) {
    const re = globToRegExp(pattern);
    const hits = files.filter((file) => re.test(file));
    if (!hits.length) warnings.push(`no file matches --paths '${pattern}'`);
    for (const file of hits) addSeed(file, `path ${pattern}`);
  }

  if (options.cluster) {
    const cluster = map.slices?.find((slice) => slice.name === options.cluster);
    if (!cluster) warnings.push(`cluster '${options.cluster}' is not in the repository map – run repo-map.ts or use --term`);
    else for (const file of cluster.files) addSeed(file, `cluster ${cluster.name}`);
  }

  if (options.term) {
    const term = options.term.toLowerCase();
    const re = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}s?\\b`, "i");
    for (const file of files) {
      const pathHit = conceptStems(file).some((stem) => stem === singular(term) || stem === term);
      const text = pathHit ? "" : readText(join(root, file)) ?? "";
      if (pathHit) addSeed(file, `term ${options.term}`);
      else if (re.test(text)) addSeed(file, `mentions ${options.term}`);
    }
  }

  if (options.table) {
    const table = options.table;
    const escaped = table.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`\\b${escaped}\\b`, "i");
    let matched = 0;
    for (const file of files) {
      const text = readText(join(root, file));
      if (text && re.test(text)) {
        addSeed(file, `table ${table}`);
        matched += 1;
      }
    }
    if (!matched) warnings.push(`no file mentions table '${table}'`);
  }

  if (options.route) {
    const routePath = options.route.replace(/^[A-Z]+\s+/, "").trim();
    const escaped = routePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(escaped, "i");
    let matched = 0;
    for (const file of files) {
      const text = readText(join(root, file));
      if (text && re.test(text)) {
        addSeed(file, `route ${options.route}`);
        matched += 1;
      }
    }
    if (!matched) warnings.push(`no file contains route '${routePath}' – pass --paths or --term`);
  }

  if (options.event) {
    const needles = [options.event.id, options.event.id.replace(/^(EVT|CMD|AGG)-/, ""), ...options.event.terms]
      .filter(Boolean)
      .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const re = new RegExp(`\\b(?:${needles.join("|")})\\b`, "i");
    let matched = 0;
    for (const file of files) {
      const text = readText(join(root, file));
      if (text && re.test(text)) {
        addSeed(file, `event ${options.event.id}`);
        matched += 1;
      }
    }
    if (!matched) warnings.push(`no file mentions ${options.event.id} – pass --paths or --term`);
  }

  if (!seeds.size) {
    return {
      query: describeQuery(options),
      seeds: [],
      files: [],
      byLayer: {},
      warnings: [...warnings, "no seed file found – the resolver is evidence, not a verdict; widen the scope with --paths or --term"],
    };
  }

  const graph = importGraph(root, files);
  const resolved = new Map<string, ResolvedFile>(seeds);
  let frontier = [...seeds.keys()];
  for (let step = 0; step < depth && frontier.length; step += 1) {
    const next: string[] = [];
    for (const file of frontier) {
      for (const target of graph.forward.get(file) ?? []) {
        if (!resolved.has(target)) {
          addFile(resolved, target, `imports ${file}`, map.packages);
          next.push(target);
        }
      }
      for (const source of graph.reverse.get(file) ?? []) {
        if (!resolved.has(source)) {
          addFile(resolved, source, `imported by ${file}`, map.packages);
          next.push(source);
        }
      }
    }
    frontier = next;
  }

  // Same concept stem across layers, even when the layers do not import each other (the classic layered case).
  const seedStems = new Set([...seeds.keys()].flatMap((file) => conceptStems(file)));
  for (const file of files) {
    if (resolved.has(file)) continue;
    const stems = conceptStems(file);
    if (stems.some((stem) => seedStems.has(stem))) addFile(resolved, file, `same concept (${stems.join(", ")})`, map.packages);
  }

  let result = [...resolved.values()].sort((a, b) => a.file.localeCompare(b.file));
  if (result.length > maxFiles) {
    warnings.push(`${result.length} candidate files – truncated to ${maxFiles}; narrow the scope`);
    result = result.slice(0, maxFiles);
  }

  const byLayer: Record<string, string[]> = {};
  for (const entry of result) (byLayer[entry.layer] ??= []).push(entry.file);
  for (const key of Object.keys(byLayer)) byLayer[key].sort();

  return {
    query: describeQuery(options),
    seeds: [...seeds.values()].sort((a, b) => a.file.localeCompare(b.file)),
    files: result,
    byLayer,
    warnings,
  };
}

function describeQuery(options: ResolveOptions): string {
  const parts: string[] = [];
  for (const path of options.paths ?? []) parts.push(`--paths ${path}`);
  if (options.route) parts.push(`--route ${options.route}`);
  if (options.table) parts.push(`--table ${options.table}`);
  if (options.event) parts.push(`--event ${options.event.id}`);
  if (options.cluster) parts.push(`--cluster ${options.cluster}`);
  if (options.term) parts.push(`--term ${options.term}`);
  return parts.join(" · ") || "(empty scope)";
}
