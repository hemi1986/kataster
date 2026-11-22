// Lint, format and type-check configs of the app that would also check Kataster's own files.
// Read-only: it reports the entries to add and never writes a user's config. The checks are textual heuristics –
// a path that is mentioned in the right file counts as handled.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Paths a formatter should leave alone: the payload, the managed blocks and the generated files. */
export const FORMAT_PATHS = [".claude/", ".opencode/", "AGENTS.md", "CLAUDE.md", "docs/domain/event-storming.md", "docs/stories/BACKLOG.md"];
/** Paths a linter or the app's type check should leave alone: the payload's TypeScript. */
export const CODE_PATHS = [".claude/", ".opencode/"];

const PRETTIER_FILES = [
  ".prettierrc", ".prettierrc.json", ".prettierrc.json5", ".prettierrc.yaml", ".prettierrc.yml", ".prettierrc.toml",
  ".prettierrc.js", ".prettierrc.cjs", ".prettierrc.mjs", ".prettierrc.ts",
  "prettier.config.js", "prettier.config.cjs", "prettier.config.mjs", "prettier.config.ts",
];
const ESLINT_FLAT = ["eslint.config.js", "eslint.config.mjs", "eslint.config.cjs", "eslint.config.ts", "eslint.config.mts", "eslint.config.cts"];
const ESLINT_LEGACY = [".eslintrc", ".eslintrc.json", ".eslintrc.js", ".eslintrc.cjs", ".eslintrc.yaml", ".eslintrc.yml"];

const read = (root, file) => {
  try {
    return readFileSync(join(root, file), "utf8");
  } catch {
    return "";
  }
};

/** `.claude/` → `.claude`; also strips a leading `/` and trailing `/**`, as ignore files write them. */
const stem = (path) => path.replace(/^\/+/, "").replace(/\/\*\*$/, "").replace(/\/+$/, "");

/** Whether an ignore file has a line for the path. */
function ignoreFileCovers(text, path) {
  const want = stem(path);
  return text.split(/\r?\n/).some((line) => {
    const entry = stem(line.trim());
    return entry === want || (want.includes("/") && entry !== "" && want.startsWith(`${entry}/`));
  });
}

function packageJson(root) {
  try {
    return JSON.parse(read(root, "package.json") || "{}");
  } catch {
    return {};
  }
}

function prettierGap(root) {
  const pkg = packageJson(root);
  const config = PRETTIER_FILES.find((file) => existsSync(join(root, file))) ?? (pkg.prettier ? "package.json" : null);
  if (!config) return null;
  const ignore = `${read(root, ".prettierignore")}\n${read(root, ".gitignore")}`;
  const missing = FORMAT_PATHS.filter((path) => !ignoreFileCovers(ignore, path));
  return missing.length ? { tool: "Prettier", config, file: ".prettierignore", missing, hint: missing.join("\n") } : null;
}

function eslintGap(root) {
  const flat = ESLINT_FLAT.find((file) => existsSync(join(root, file)));
  if (flat) {
    const text = read(root, flat);
    const missing = CODE_PATHS.filter((path) => !text.includes(stem(path)));
    return missing.length
      ? { tool: "ESLint", config: flat, file: flat, missing, hint: `{ ignores: [${missing.map((p) => `"${stem(p)}/**"`).join(", ")}] }` }
      : null;
  }
  const pkg = packageJson(root);
  const legacy = ESLINT_LEGACY.find((file) => existsSync(join(root, file))) ?? (pkg.eslintConfig ? "package.json" : null);
  if (!legacy) return null;
  const text = `${read(root, ".eslintignore")}\n${read(root, legacy)}`;
  const missing = CODE_PATHS.filter((path) => !ignoreFileCovers(text, path) && !text.includes(`"${stem(path)}`));
  return missing.length ? { tool: "ESLint", config: legacy, file: ".eslintignore", missing, hint: missing.join("\n") } : null;
}

/** A root tsconfig without `include` (or with a catch-all one) also type-checks `.claude/**\/*.ts`. */
function tsconfigGap(root) {
  const text = read(root, "tsconfig.json");
  if (!text) return null;
  const include = /"include"\s*:\s*\[([^\]]*)\]/.exec(text)?.[1];
  const files = /"files"\s*:\s*\[/.test(text);
  const catchAll = include === undefined
    ? !files
    : include.split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).some((p) => /^(\.\/)?\*\*/.test(p) || p === "." || p === "./" || p === "*");
  if (!catchAll) return null;
  const exclude = /"exclude"\s*:\s*\[([^\]]*)\]/.exec(text)?.[1] ?? "";
  const missing = CODE_PATHS.filter((path) => !exclude.includes(stem(path)));
  return missing.length
    ? { tool: "TypeScript", config: "tsconfig.json", file: "tsconfig.json", missing, hint: `"exclude": [${missing.map((p) => `"${stem(p)}"`).join(", ")}]` }
    : null;
}

/** Configs that would check Kataster's files, with the entries they lack. Empty when everything is excluded. */
export function toolIgnoreGaps(root) {
  if (!existsSync(root) || !readdirSync(root).length) return [];
  return [prettierGap(root), eslintGap(root), tsconfigGap(root)].filter(Boolean);
}

/** The hint `init` prints. */
export function formatToolIgnoreHint(gaps) {
  if (!gaps.length) return "";
  const lines = ["", "Your lint/format config also checks Kataster's own files. Add these entries (nothing was changed):"];
  for (const gap of gaps) {
    lines.push(`  ${gap.tool} – ${gap.file}:`);
    for (const line of gap.hint.split("\n")) lines.push(`    ${line}`);
  }
  lines.push("  `npx kataster doctor` checks them again later.");
  return lines.join("\n");
}
