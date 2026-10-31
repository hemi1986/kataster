import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { Installer, VERSION } from "./install.mjs";
import { buildProfile, detectProject } from "./detect.mjs";
import { readJson, write } from "./util.mjs";

const HELP = `Kataster ${VERSION} – agent workflow for domain-driven discovery and delivery

Usage:
  kataster init [dir]      Install the workflow into a repository (default: .)
  kataster upgrade [dir]   Update the workflow, keep project content and local changes
  kataster doctor [dir]    Check the installation
  kataster --version
  kataster --help

Options:
  --brownfield          Existing codebase: start with /adopt (default when code is found)
  --greenfield          New project: start with /bootstrap
  --name <name>         Project name (default: directory name)
  --ui-language <lang>  Language of the user interface (default: en)
  --artifacts <lang>    Language of docs, stories and code comments (default: en)
  --backlog <provider>  Where stories live: local (default), github, jira
  --jira-project <key>  Jira project key (with --backlog jira)
  --github-repo <repo>  GitHub repository owner/name (with --backlog github; default: this repo)
  --force               Overwrite locally modified workflow files (backup is kept)
  --no-install          Do not run "npm install --prefix .claude"
  --yes, -y             Non-interactive: accept the detected defaults
  --dry-run             Show what would happen, write nothing
`;

function parse(argv) {
  const options = { _: [] };
  const takesValue = new Set(["name", "ui-language", "artifacts", "backlog", "jira-project", "github-repo"]);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("-")) {
      options._.push(arg);
      continue;
    }
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--version" || arg === "-v") options.version = true;
    else if (arg === "--brownfield") options.brownfield = true;
    else if (arg === "--greenfield") options.greenfield = true;
    else if (arg === "--force") options.force = true;
    else if (arg === "--no-install") options.noInstall = true;
    else if (arg === "--yes" || arg === "-y") options.yes = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--with" || arg.startsWith("--with=")) {
      throw new Error("--with was removed in 0.3.0 – install an extra such as shadcn/ui directly in your project.");
    }
    else if (arg.startsWith("--") && arg.includes("=")) {
      const [key, ...rest] = arg.slice(2).split("=");
      options[camel(key)] = rest.join("=");
    } else if (arg.startsWith("--") && takesValue.has(arg.slice(2))) {
      options[camel(arg.slice(2))] = argv[++i];
    } else if (arg.startsWith("--")) options[camel(arg.slice(2))] = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

async function ask(question, fallback, { yes } = {}) {
  if (yes) return fallback;
  if (!stdin.isTTY) return fallback;
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = (await rl.question(`${question}${fallback ? ` [${fallback}]` : ""}: `)).trim();
    return answer || fallback;
  } finally {
    rl.close();
  }
}

function banner() {
  console.log(`\n  Kataster ${VERSION}\n  Discovery and delivery workflow for agent harnesses\n`);
}

function nextSteps(root, profile) {
  const rel = root === resolve(".") ? "." : root;
  const command = profile.kind === "brownfield" ? "/adopt" : "/bootstrap";
  console.log(`
Next steps in ${rel}:
  1. Review .claude/project.json – name, stack, languages, commands.
  2. Open the repository in OpenCode (or Claude Code) and run ${command}.
     ${profile.kind === "brownfield"
       ? "It analyses code, docs, tests and git history, drafts the domain model, then grills you to correct it."
       : "It grills the vision, runs the event storming and builds the domain model with you."}
  3. Read CONTEXT.md and docs/domain/events.yaml as they fill up – they are the source of truth.
${profile.backlog?.provider && profile.backlog.provider !== "local"
    ? `  4. Backlog backend: ${profile.backlog.provider}. Fill in .claude/project.json and sync with /backlog-sync.`
    : ""}

Useful commands afterwards:
  /grill-me /grill-with-docs   sharpen a plan and write the docs as you go
  /event-storming              explore a process or the whole domain
  /feature <idea>              add a feature through grilling, storming, stories
  /review-stories              one lead-dev pass before a story is ready
  /implement [ST-NNN]          test-first implementation of one story
  /backlog-sync                pull/push the backlog mirror (Jira or GitHub Issues)
  /retro                       retrospective on a session
`);
}

function printSummary(installer) {
  const { created, updated, conflicts } = installer.summary();
  console.log(`\nDone: ${created} created, ${updated} updated.`);
  if (conflicts.length) {
    console.log(`\n${conflicts.length} file(s) kept because they were modified locally:`);
    for (const c of conflicts) console.log(`  - ${c}`);
    console.log("  Run with --force to overwrite them (a backup is written to .kataster/backup/).");
  }
}

async function init(options) {
  const root = resolve(options._[1] ?? ".");
  const detection = detectProject(root);

  banner();
  if (existsSync(join(root, ".claude", "install.json"))) {
    console.log(`${root} already has a Kataster installation – running upgrade.\n`);
    return upgrade({ ...options, _: ["upgrade", root] });
  }
  console.log(`Installing into ${root}`);
  console.log(`Detected: ${detection.kind}, ${detection.languages.join(", ") || "no code yet"}${
    detection.frameworks.length ? `, ${detection.frameworks.join(", ")}` : ""
  }${detection.databases.length ? `, ${detection.databases.join(", ")}` : ""}${
    detection.repoTooling?.monorepo ? `, ${detection.repoTooling.kind} monorepo` : ""
  }\n`);

  const kind = options.brownfield ? "brownfield" : options.greenfield ? "greenfield" : detection.kind;
  const name = await ask("Project name", options.name || detection.packageName || basename(root), options);
  const uiLanguage = await ask("UI language (en, de, …)", options.uiLanguage || "en", options);
  const artifactLanguage = await ask("Language of docs and stories", options.artifacts || "en", options);
  const backlog = await ask("Backlog backend (local, github, jira)", options.backlog || "local", options);
  if (!["local", "github", "jira"].includes(backlog)) {
    throw new Error(`Unknown backlog backend '${backlog}' – use local, github or jira.`);
  }
  const jiraProject = backlog === "jira"
    ? await ask("Jira project key (e.g. PROJ)", options.jiraProject || "", options)
    : "";
  const githubRepo = backlog === "github"
    ? await ask("GitHub repository (owner/name, empty = this repo)", options.githubRepo || "", options)
    : "";

  const profile = buildProfile(root, {
    name, kind, uiLanguage, artifactLanguage, detection,
    backlog, jiraProject, githubRepo,
  });
  profile.workflow.version = VERSION;

  const installer = new Installer(root, { dryRun: options.dryRun, force: options.force, log: (line) => console.log(`  ${line}`) });
  installer.migrateLegacy();
  installer.copyWorkflowDirs();
  installer.mergeSettings();
  installer.mergeOpencodeConfig();
  installer.mergeAgentsFile(profile);
  installer.copyDocsSkeleton(profile);
  installer.putContext(profile);
  installer.putClaudeMd(profile);
  installer.putProfile(profile);
  installer.putConventions(profile);
  installer.updateGitignore();
  installer.writeManifest();

  if (options.dryRun) {
    console.log("\nDry run – nothing was written.");
    return;
  }

  if (!options.noInstall) {
    const result = installer.installToolingDependencies();
    if (!result.ok) console.log("\nTooling dependencies could not be installed – run: npm install --prefix .claude");
  }

  printSummary(installer);
  nextSteps(root, profile);
}

async function upgrade(options) {
  const root = resolve(options._[1] ?? ".");
  banner();
  const installer = new Installer(root, { dryRun: options.dryRun, force: options.force, log: (line) => console.log(`  ${line}`) });
  if (!installer.manifest) {
    console.log(`No installation found in ${root} – running init instead.\n`);
    return init({ ...options, _: ["init", root] });
  }
  const profile = readJson(join(root, ".claude", "project.json")) ?? {};

  console.log(`Upgrading ${root} from ${installer.manifest.version ?? "?"} to ${VERSION}\n`);
  installer.migrateLegacy();
  installer.copyWorkflowDirs();
  installer.mergeSettings();
  installer.mergeOpencodeConfig();
  if (profile.name) installer.mergeAgentsFile(profile);
  installer.copyDocsSkeleton(profile);
  installer.putContext(profile);
  installer.putClaudeMd(profile);
  installer.putConventions(profile);
  installer.updateGitignore();
  installer.writeManifest();

  if (profile.name && !options.dryRun) {
    profile.workflow = { ...(profile.workflow ?? {}), version: VERSION };
    delete profile.workflow.extras;
    write(join(root, ".claude", "project.json"), `${JSON.stringify(profile, null, 2)}\n`);
  }

  if (options.dryRun) {
    console.log("\nDry run – nothing was written.");
    return;
  }
  if (!options.noInstall) installer.installToolingDependencies();
  printSummary(installer);
  console.log("\nUpgrade complete. Project content (CONTEXT.md, docs/domain, docs/stories, ADRs) was not touched.");
}

function doctor(options) {
  const root = resolve(options._[1] ?? ".");
  const checks = [];
  const add = (name, ok, detail = "") => checks.push({ name, ok, detail });

  add("Node >= 22.18", Number(process.versions.node.split(".")[0]) > 22 || (Number(process.versions.node.split(".")[0]) === 22 && Number(process.versions.node.split(".")[1]) >= 18), process.versions.node);
  add("Workflow installed", existsSync(join(root, ".claude", "skills")) && existsSync(join(root, ".opencode")), root);
  const manifest = readJson(join(root, ".claude", "install.json"));
  add("Install manifest", Boolean(manifest), manifest ? `version ${manifest.version}` : "missing – run init");
  const leftovers = existsSync(join(root, ".laguardia")) || existsSync(join(root, ".opencode", "plugins", "laguardia"));
  add("No leftovers from the old name", !leftovers, leftovers ? "run upgrade to migrate them" : "");
  const profile = readJson(join(root, ".claude", "project.json"));
  add("Project profile", Boolean(profile?.name), profile?.name ?? "missing");

  const backlog = profile?.backlog ?? {};
  const provider = backlog.provider ?? "local";
  add("Backlog provider", ["local", "github", "jira"].includes(provider), provider);
  if (provider === "jira") {
    add("Backlog: Jira project", Boolean(backlog.jira?.project), backlog.jira?.project || "backlog.jira.project is missing");
    const statuses = ["draft", "review", "ready", "in-progress", "done", "superseded"];
    const missingStatuses = statuses.filter((status) => !backlog.jira?.statusMap?.[status]);
    add("Backlog: Jira status map", missingStatuses.length === 0, missingStatuses.join(", ") || "all statuses mapped");
    const priorities = ["must", "should", "could", "wont"];
    const missingPriorities = priorities.filter((priority) => !backlog.jira?.priorityMap?.[priority]);
    add("Backlog: Jira priority map", missingPriorities.length === 0, missingPriorities.join(", ") || "all priorities mapped");
    const server = backlog.jira?.mcpServer || "mcp-atlassian";
    const configured = [".mcp.json", ".claude/settings.json", ".claude/settings.local.json", ".opencode/opencode.jsonc"].some((file) => {
      try {
        return existsSync(join(root, file)) && readFileSync(join(root, file), "utf8").includes(server);
      } catch {
        return false;
      }
    });
    add(`Backlog: MCP server '${server}'`, configured, configured ? "" : "configure mcp-atlassian in your harness");
  }
  if (provider === "github") {
    const gh = spawnSync("gh", ["--version"], { encoding: "utf8" });
    add("Backlog: GitHub CLI", gh.status === 0, gh.status === 0 ? "" : "https://cli.github.com");
    if (gh.status === 0) {
      const auth = spawnSync("gh", ["auth", "status"], { encoding: "utf8" });
      add("Backlog: gh authenticated", auth.status === 0, auth.status === 0 ? "" : "gh auth login");
    }
    add("Backlog: GitHub repo", true, backlog.github?.repo || "current repository");
  }
  add("Tooling dependencies", existsSync(join(root, ".claude", "node_modules", "yaml")), "npm install --prefix .claude");
  for (const file of ["CONTEXT.md", "docs/domain/events.yaml", "docs/product/vision.md", "docs/stories"]) {
    add(file, existsSync(join(root, file)), "");
  }
  const events = join(root, ".claude/skills/event-storming/scripts/validate-events.ts");
  if (existsSync(events) && existsSync(join(root, ".claude", "node_modules", "yaml"))) {
    const r = spawnSync(process.execPath, [events], { cwd: root, encoding: "utf8" });
    add("events.yaml valid", r.status === 0, (r.stdout + r.stderr).trim().split("\n").slice(-1)[0] ?? "");
  } else if (existsSync(events)) {
    add("events.yaml valid", true, "skipped – tooling dependencies missing");
  }

  banner();
  console.log(`Doctor – ${root}\n`);
  for (const check of checks) console.log(`  ${check.ok ? "✓" : "✗"} ${check.name}${check.detail ? `  (${check.detail})` : ""}`);
  const failed = checks.filter((c) => !c.ok);
  console.log(failed.length ? `\n${failed.length} check(s) failed.` : "\nEverything looks good.");
  process.exitCode = failed.length ? 1 : 0;
}

export async function main(argv) {
  const options = parse(argv);
  if (options.help || argv.length === 0) {
    console.log(HELP);
    return;
  }
  if (options.version) {
    console.log(VERSION);
    return;
  }
  const command = options._[0];
  if (command === "init") return init(options);
  if (command === "upgrade") return upgrade(options);
  if (command === "doctor") return doctor(options);
  throw new Error(`Unknown command '${command}'. Try --help.`);
}
