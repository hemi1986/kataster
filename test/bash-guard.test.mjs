import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const hook = resolve(here, "..", ".claude", "hooks", "bash-guard.ts");

function guard(command) {
  const r = spawnSync(process.execPath, [hook], {
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }),
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL: "postgres://prod.example.com/app", POSTGRES_URL: "" },
  });
  return r.status;
}

const BLOCKED = [
  "vercel deploy --prod",
  "npx vercel --prod",
  "cd app && vercel --prod",
  "git commit -m 'wip' && vercel --prod",
  'vercel "--prod"',
  'bash -c "vercel deploy --prod"',
  "sh -lc 'netlify deploy --prod'",
  'eval "vercel --prod"',
  'echo "$(vercel --prod)"',
  "echo `vercel --prod`",
  "git push --force origin feature",
  "git push origin +feature",
  'git push origin "+feature"',
  "git push --force-with-lease origin main",
  'psql "$URL" -c "DROP TABLE users"',
  "psql app <<SQL\nDROP TABLE users;\nSQL",
  'echo "DROP TABLE users" | psql -c "TRUNCATE users"',
  "redis-cli FLUSHALL",
];

const ALLOWED = [
  'echo "probe: vercel deploy --prod (text only, no deploy)"',
  "printf '%s\\n' 'vercel --prod'",
  'git commit -m "Document that vercel --prod is blocked"',
  'git commit -m "fix; vercel --prod && git push --force"',
  "git commit -F - <<'EOF'\nExplain vercel --prod\ngit push --force\nEOF",
  'gh pr create --title "Guard" --body "no more psql -c DROP TABLE false alarms"',
  'echo "psql -c DROP TABLE users"',
  "git push --force-with-lease origin feature",
  "vercel deploy",
  "psql postgres://localhost/app -c 'DROP TABLE users'",
  "ls -la 2>&1 | grep prod",
];

test("bash-guard blocks the command that runs, also behind wrappers, -c, eval and substitutions", () => {
  for (const command of BLOCKED) assert.equal(guard(command), 2, `not blocked: ${command}`);
});

test("bash-guard ignores quoted text, echo output, commit messages and heredoc bodies", () => {
  for (const command of ALLOWED) assert.equal(guard(command), 0, `blocked: ${command}`);
});
