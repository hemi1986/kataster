import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { detectRepoTooling } from "./repo.mjs";

const IGNORED = new Set([".git", ".claude", ".opencode", "node_modules", "dist", "build", "out", "coverage", ".next", "vendor", "target"]);
const CODE_EXT = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte", ".astro",
  ".py", ".go", ".rs", ".java", ".kt", ".kts", ".rb", ".php", ".cs", ".swift", ".scala", ".ex", ".exs", ".dart",
]);

function anyFile(dir, names) {
  return names.some((name) => existsSync(join(dir, name)));
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function countCode(root, limit = 4000) {
  const byExt = new Map();
  let total = 0;
  const walk = (dir) => {
    if (total >= limit) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (total >= limit) return;
      if (entry.isDirectory()) {
        if (!IGNORED.has(entry.name) && !entry.name.startsWith(".")) walk(join(dir, entry.name));
      } else if (entry.isFile()) {
        const dot = entry.name.lastIndexOf(".");
        if (dot < 0) continue;
        const ext = entry.name.slice(dot).toLowerCase();
        if (!CODE_EXT.has(ext)) continue;
        if (/\.(test|spec)\./.test(entry.name)) continue;
        byExt.set(ext, (byExt.get(ext) ?? 0) + 1);
        total += 1;
      }
    }
  };
  walk(root);
  return byExt;
}

// Lockfiles before the manifest: a pnpm/yarn/bun repository also has a package.json, and the lockfile is the
// package manager that actually installs and runs the scripts.
const ECOSYSTEMS = [
  { marker: ["pnpm-lock.yaml"], language: "TypeScript/JavaScript", manager: "pnpm", install: "pnpm install" },
  { marker: ["yarn.lock"], language: "TypeScript/JavaScript", manager: "yarn", install: "yarn install" },
  { marker: ["bun.lockb", "bun.lock"], language: "TypeScript/JavaScript", manager: "bun", install: "bun install" },
  { marker: ["package.json"], language: "TypeScript/JavaScript", manager: "npm", install: "npm install" },
  { marker: ["go.mod"], language: "Go", manager: "go", install: "go mod download" },
  { marker: ["Cargo.toml"], language: "Rust", manager: "cargo", install: "cargo build" },
  { marker: ["pyproject.toml", "requirements.txt", "setup.py"], language: "Python", manager: "pip", install: "pip install -r requirements.txt" },
  { marker: ["pom.xml"], language: "Java", manager: "maven", install: "mvn install" },
  { marker: ["build.gradle", "build.gradle.kts"], language: "Kotlin/Java", manager: "gradle", install: "./gradlew build" },
  { marker: ["Gemfile"], language: "Ruby", manager: "bundler", install: "bundle install" },
  { marker: ["composer.json"], language: "PHP", manager: "composer", install: "composer install" },
  { marker: ["*.csproj", "*.sln"], language: "C#", manager: "dotnet", install: "dotnet restore" },
];

const FRAMEWORKS = {
  next: "Next.js", react: "React", vue: "Vue", nuxt: "Nuxt", svelte: "Svelte", "@sveltejs/kit": "SvelteKit",
  astro: "Astro", angular: "Angular", "@angular/core": "Angular", express: "Express", fastify: "Fastify",
  "@nestjs/core": "NestJS", koa: "Koa", remix: "Remix", "@remix-run/react": "Remix", electron: "Electron",
  "solid-js": "Solid", hono: "Hono", trpc: "tRPC", "@trpc/server": "tRPC",
};
const DATABASES = {
  prisma: "Prisma", "@prisma/client": "PostgreSQL/Prisma", drizzle: "Drizzle", "drizzle-orm": "Drizzle",
  pg: "PostgreSQL", postgres: "PostgreSQL", mysql2: "MySQL", mongoose: "MongoDB", mongodb: "MongoDB",
  sequelize: "SQL", knex: "SQL", typeorm: "SQL", "@supabase/supabase-js": "Supabase", redis: "Redis",
};
const TESTERS = { vitest: "Vitest", jest: "Jest", mocha: "Mocha", playwright: "Playwright", "@playwright/test": "Playwright", cypress: "Cypress", ava: "AVA" };

const CODE_ROOTS = ["src", "app", "lib", "packages", "apps", "services", "server", "client", "web", "api", "cmd", "internal", "pkg"];

export function detectProject(root) {
  const codeCounts = countCode(root);
  const codeFiles = [...codeCounts.values()].reduce((a, b) => a + b, 0);
  const ecosystem = ECOSYSTEMS.find((e) => anyFile(root, e.marker)) ?? undefined;
  const repoTooling = detectRepoTooling(root);
  const pkg = readJson(join(root, "package.json"));
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  const names = Object.keys(deps);
  const hasDependency = (name) => names.some((n) => n === name || n.startsWith(`${name}/`));

  const frameworks = Object.entries(FRAMEWORKS).filter(([dep]) => hasDependency(dep)).map(([, label]) => label);
  const databases = Object.entries(DATABASES).filter(([dep]) => hasDependency(dep)).map(([, label]) => label);
  const testers = Object.entries(TESTERS).filter(([dep]) => hasDependency(dep)).map(([, label]) => label);

  const languages = [];
  if (existsSync(join(root, "tsconfig.json")) || codeCounts.has(".ts") || codeCounts.has(".tsx")) languages.push("TypeScript");
  if ([".js", ".jsx", ".mjs", ".cjs"].some((e) => codeCounts.has(e))) languages.push("JavaScript");
  for (const [ext, label] of [[".py", "Python"], [".go", "Go"], [".rs", "Rust"], [".java", "Java"], [".kt", "Kotlin"], [".rb", "Ruby"], [".php", "PHP"], [".cs", "C#"], [".vue", "Vue"], [".svelte", "Svelte"]]) {
    if (codeCounts.has(ext) && !languages.includes(label)) languages.push(label);
  }

  const codeRoots = CODE_ROOTS.filter((dir) => {
    try {
      return statSync(join(root, dir)).isDirectory();
    } catch {
      return false;
    }
  });
  const scripts = pkg?.scripts ?? {};
  const manager = ecosystem?.manager ?? "npm";
  const run = (script) => (manager === "npm" || manager === "bun" ? `${manager} run ${script}` : `${manager} ${script}`);

  // An empty `package.json` is not a codebase; a manifest with dependencies, scripts or another ecosystem is.
  const packageContent =
    Boolean(pkg) && (Object.keys(deps).length > 0 || Object.keys(scripts).length > 0);
  const otherEcosystem = Boolean(ecosystem) && !["npm", "bun", "yarn", "pnpm"].includes(ecosystem.manager);

  const commands = {
    install: ecosystem?.install ?? "",
    lint: scripts.lint ? run("lint") : "",
    typecheck: scripts.typecheck ? run("typecheck") : scripts["type-check"] ? run("type-check") : "",
    test: scripts.test ? run("test") : "",
    e2e: scripts["test:e2e"] ? run("test:e2e") : "",
    verify: "node .claude/skills/implement/scripts/verify.ts",
  };

  // Sensible defaults per ecosystem, only where the repository does not name a command itself.
  const defaults = {
    go: { lint: "go vet ./...", typecheck: "go build ./...", test: "go test ./..." },
    cargo: { lint: "cargo clippy -- -D warnings", typecheck: "cargo check", test: "cargo test" },
    maven: { test: "mvn -q test" },
    gradle: { test: "./gradlew test" },
    bundler: { test: "bundle exec rspec" },
    composer: { test: "composer test" },
    pip: { test: "pytest" },
  };
  for (const [key, value] of Object.entries(defaults[manager] ?? {})) if (!commands[key]) commands[key] = value;

  return {
    kind: codeFiles > 0 || packageContent || otherEcosystem ? "brownfield" : "greenfield",
    packageName: typeof pkg?.name === "string" ? pkg.name : undefined,
    ecosystem: ecosystem?.language ?? languages[0] ?? "unknown",
    languages,
    frameworks: [...new Set(frameworks)],
    databases: [...new Set(databases)],
    testers: [...new Set(testers)],
    packageManager: manager,
    codeRoots: codeRoots.length ? codeRoots : ["."],
    codeFiles,
    scripts,
    commands,
    repoTooling,
  };
}

export function buildProfile(root, { name, kind, uiLanguage, artifactLanguage, detection, extras = [], backlog = "local", jiraProject = "", githubRepo = "" }) {
  const stackSummary = [
    ...detection.languages,
    ...detection.frameworks,
    ...detection.databases,
  ].filter((v, i, a) => a.indexOf(v) === i).join(", ") || "unknown";
  const provider = ["local", "github", "jira"].includes(backlog) ? backlog : "local";

  return {
    name: name || basename(root),
    kind: kind || detection.kind,
    domain: name || basename(root),
    languages: {
      artifacts: artifactLanguage || "en",
      ui: uiLanguage || "en",
      uiAdditional: [],
    },
    stack: {
      summary: stackSummary,
      languages: detection.languages,
      frameworks: detection.frameworks,
      databases: detection.databases,
      testers: detection.testers,
      packageManager: detection.packageManager,
    },
    repo: {
      defaultBranch: "main",
      codeRoots: detection.codeRoots,
      // Monorepo build tooling. The workflow uses this instead of assuming one package at the root:
      // commands per package, dependency edges, consumers of a shared library and affected tests.
      tooling: detection.repoTooling ?? { kind: "none", config: "", workspaces: [], manager: "", monorepo: false },
    },
    commands: detection.commands,
    review: {
      preview: "none",
      pullRequest: existsSync(join(root, ".git")) ? "gh" : "none",
    },
    // Where stories live. `local` keeps docs/stories/ as the backlog; `github`/`jira` make the tracker the source of
    // truth and docs/stories/ its local mirror. The defaults are deliberately generic – edit them after init.
    // Keep the maps in sync with .claude/lib/config.ts (DEFAULT_STATUS_MAP / DEFAULT_PRIORITY_MAP).
    backlog: {
      provider,
      github: {
        repo: githubRepo,
        labelPrefix: "kataster",
      },
      jira: {
        mcpServer: "mcp-atlassian",
        project: jiraProject,
        issueType: "Story",
        labelPrefix: "kataster",
        statusMap: {
          draft: "To Do",
          review: "In Review",
          ready: "Ready",
          "in-progress": "In Progress",
          done: "Done",
          superseded: "Won't Do",
        },
        priorityMap: {
          must: "Highest",
          should: "High",
          could: "Medium",
          wont: "Lowest",
        },
      },
    },
    setup: {
      envFile: "",
      envHint: "",
    },
    workflow: {
      version: "0.1.0",
      extras,
      installedAt: new Date().toISOString(),
    },
  };
}
