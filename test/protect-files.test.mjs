import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cli = resolve(here, "..", "bin", "kataster.mjs");
const yamlSource = resolve(here, "..", ".claude", "node_modules", "yaml");

function installed() {
  const dir = mkdtempSync(join(tmpdir(), "kataster-protect-"));
  writeFileSync(join(dir, "package.json"), "{}", "utf8");
  const init = spawnSync(process.execPath, [cli, "init", dir, "--yes", "--no-install"], { encoding: "utf8" });
  assert.equal(init.status, 0, `${init.stdout}${init.stderr}`);
  mkdirSync(join(dir, ".claude", "node_modules"), { recursive: true });
  cpSync(yamlSource, join(dir, ".claude", "node_modules", "yaml"), { recursive: true });
  return dir;
}

const dir = installed();
const adrPath = join(dir, "docs", "adr", "0001-use-events.md");

const ADR = `---
status: accepted
date: 2026-11-01
---

# Use events

Orders are stored as events in \`src/orders/\`, because the audit needs the history.
`;
const LOGGED = `${ADR}
## Editorial changes
- 2026-11-10: fixed a typo
`;

/** Runs the hook for an Edit (or a Write when `content` is given) against `current`. */
function hook(current, change) {
  mkdirSync(dirname(adrPath), { recursive: true });
  writeFileSync(adrPath, current, "utf8");
  const input = change.content !== undefined
    ? { tool_name: "Write", tool_input: { file_path: adrPath, content: change.content } }
    : { tool_name: "Edit", tool_input: { file_path: adrPath, old_string: change.old, new_string: change.new } };
  const r = spawnSync(process.execPath, [join(dir, ".claude", "hooks", "protect-files.ts")], {
    input: JSON.stringify({ ...input, cwd: dir }),
    encoding: "utf8",
  });
  return { code: r.status, err: r.stderr };
}

const fixPath = (text) => text.replace("`src/orders/`", "`apps/orders/`");

test("an accepted ADR blocks an unlogged edit and explains both ways", () => {
  const r = hook(ADR, { old: "`src/orders/`", new: "`apps/orders/`" });
  assert.equal(r.code, 2);
  assert.match(r.err, /## Editorial changes/);
  assert.match(r.err, /superseded by ADR-NNNN/);
});

test("an editorial edit with a new log entry is allowed", () => {
  const next = `${fixPath(ADR)}\n## Editorial changes\n- 2026-11-22: path after the move\n`;
  assert.equal(hook(ADR, { content: next }).code, 0);
  const appended = `${fixPath(LOGGED)}- 2026-11-22: path after the move\n`;
  assert.equal(hook(LOGGED, { content: appended }).code, 0);
});

test("the log cannot be rewritten and the ADR must stay accepted", () => {
  // An old entry is replaced instead of a new one added.
  assert.equal(hook(LOGGED, { old: "- 2026-11-10: fixed a typo", new: "- 2026-11-22: changed the decision" }).code, 2);
  // A logged edit that also changes the status.
  const reopened = `${fixPath(LOGGED).replace("status: accepted", "status: proposed")}- 2026-11-22: reopened\n`;
  assert.equal(hook(LOGGED, { content: reopened }).code, 2);
  // An entry without a date does not count.
  assert.equal(hook(ADR, { content: `${fixPath(ADR)}\n## Editorial changes\n- path after the move\n` }).code, 2);
});

test("superseding stays allowed, but only as a pure status change", () => {
  assert.equal(hook(ADR, { old: "status: accepted", new: "status: superseded by ADR-0002" }).code, 0);
  assert.equal(hook(ADR, { content: fixPath(ADR).replace("status: accepted", "status: superseded by ADR-0002") }).code, 2);
});

test("a proposed ADR can be edited freely", () => {
  const proposed = ADR.replace("status: accepted", "status: proposed");
  assert.equal(hook(proposed, { old: "`src/orders/`", new: "`apps/orders/`" }).code, 0);
});
