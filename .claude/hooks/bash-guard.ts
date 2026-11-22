/**
 * PreToolUse hook (Bash): blocks commands that are hard to undo. The user can still run them
 * themselves (`! <command>` in the prompt).
 *
 * - force pushes (`--force-with-lease` is allowed, except onto the default branch)
 * - production deployments from the CLI (Vercel, Netlify, Fly, Railway, Heroku, …)
 * - destructive database commands unless they clearly target a local database
 *
 * Only the command that runs is checked: text in quotes, heredoc bodies, `echo`/`printf` output and commit messages
 * are not (`.claude/lib/shell.ts`). What does run – `$(…)`, backticks, `bash -c "…"`, `eval` – is checked too. SQL is
 * usually quoted, so the database check also reads quoted arguments, except for commands that only print or record
 * text.
 *
 * Provider and tool names are matched generically; a project that uses something else can extend the lists below
 * without touching the logic.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../lib/discovery.ts";
import { segments } from "../lib/shell.ts";

let data: Record<string, any>;
try {
  data = JSON.parse(readFileSync(0, "utf8"));
} catch {
  process.exit(0);
}
const cmd: unknown = data.tool_input?.command;
if (typeof cmd !== "string" || !cmd) process.exit(0);

function block(msg: string): never {
  process.stderr.write(`Blocked: ${msg} If this is really intended, ask the user to run it themselves.\n`);
  process.exit(2);
}

/** The protected branch: the project's default branch, plus the usual names. */
function defaultBranch(): string {
  try {
    const profile = JSON.parse(readFileSync(join(ROOT, ".claude", "project.json"), "utf8"));
    return String(profile.repo?.defaultBranch ?? "main");
  } catch {
    return "main";
  }
}

const LOCAL_DB = /(localhost|127\.0\.0\.1|\[::1\]|@db:|@postgres:|\.local\b)/;

/** Deploy CLIs and the flag that means "this one is live". */
const PROD_DEPLOY = [
  /\bvercel\b.*(\s--prod\b|\bpromote\b)/,
  /\bnetlify\b.*(\bdeploy\b.*--prod\b|\b--prod\b)/,
  /\bfly(ctl)?\b.*\bdeploy\b.*--(prod|production)\b/,
  /\brailway\b.*\bup\b.*--(prod|production)\b/,
  /\bheroku\b.*\b(releases?:promote|promote)\b/,
  /\baws\b.*\b(cloudformation|ecs|s3)\b.*\b(deploy|update-stack|sync)\b/,
];

/** Commands that can drop or truncate data. */
const DESTRUCTIVE_DB = [
  /\b(prisma\s+migrate\s+reset|prisma\s+db\s+push\b.*--force-reset)\b/i,
  /\b(drizzle-kit\s+drop|knex\s+migrate:rollback\s+--all|dropdb|mongorestore\s+--drop)\b/i,
  /\b(psql|pgcli|mysql|mariadb|mongo|mongosh|sqlite3|prisma|drizzle-kit)\b.*\b(DROP\s+(DATABASE|SCHEMA|TABLE)|TRUNCATE)\b/i,
  /\b(redis-cli|valkey-cli)\b.*\b(FLUSHALL|FLUSHDB)\b/i,
];

/** Commands that only print or record their arguments – a DROP TABLE in their text is not executed. */
const TEXT_ONLY = new Set(["echo", "printf", "git", "gh", "cat", "grep", "rg", "true", ":"]);

/** DATABASE_URL the command would use: inline assignment, else the project's .env files, else the environment. */
function databaseUrl(): string {
  const inline = /\b(?:DATABASE_URL|POSTGRES_URL)=("[^"]*"|'[^']*'|\S+)/.exec(cmd as string)?.[1];
  if (inline) return inline;
  for (const f of [".env.local", ".env.development.local", ".env"]) {
    const p = join(ROOT, f);
    if (!existsSync(p)) continue;
    const m = /^\s*(?:DATABASE_URL|POSTGRES_URL)\s*=\s*(.+)$/m.exec(readFileSync(p, "utf8"));
    if (m) return m[1];
  }
  return process.env.DATABASE_URL ?? process.env.POSTGRES_URL ?? "";
}

for (const { masked, raw, head } of segments(cmd)) {
  if (/\bgit\s+push\b/.test(masked)) {
    if (/(\s--force(?!-with-lease)\b|\s-f\b|\s\+\S+)/.test(masked)) block("force push.");
    const branch = defaultBranch();
    if (/--force-with-lease/.test(masked) && new RegExp(`\\b(${branch}|main|master)\\b`).test(masked))
      block(`force push onto ${branch}.`);
  }

  if (PROD_DEPLOY.some((re) => re.test(masked))) {
    block("production deployment from the CLI – production deploys only via merge to the default branch.");
  }

  const destructive = !TEXT_ONLY.has(head) && DESTRUCTIVE_DB.some((re) => re.test(raw));
  if (destructive && !LOCAL_DB.test(raw) && !LOCAL_DB.test(databaseUrl())) {
    block("destructive database command and the target database is not clearly local.");
  }
}
process.exit(0);
