import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cli = resolve(here, "..", "bin", "kataster.mjs");
const yamlSource = resolve(here, "..", ".claude", "node_modules", "yaml");

function write(dir, path, content) {
  const target = join(dir, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, "utf8");
}

test("the glossary language check skips the tool's own files", () => {
  const dir = mkdtempSync(join(tmpdir(), "kataster-language-"));
  writeFileSync(join(dir, "package.json"), "{}", "utf8");
  const init = spawnSync(process.execPath, [cli, "init", dir, "--yes", "--no-install"], { cwd: dir, encoding: "utf8" });
  assert.equal(init.status, 0, `${init.stdout}${init.stderr}`);
  mkdirSync(join(dir, ".claude", "node_modules"), { recursive: true });
  cpSync(yamlSource, join(dir, ".claude", "node_modules", "yaml"), { recursive: true });

  write(dir, "CONTEXT.md", "# Glossary\n\n**Visit**:\nA stay of a guest.\n_Avoid_: session\n");
  write(dir, "src/visit.ts", "export const session = 1;\n");
  // Tool-owned paths: the installed harness payload and the backup directory.
  write(dir, ".opencode/plugins/extra.ts", "export const session = 1;\n");
  write(dir, ".kataster/backup/old.ts", "export const session = 1;\n");
  assert.ok(existsSync(join(dir, ".opencode")), "init did not install .opencode");

  const r = spawnSync(process.execPath, [join(dir, ".claude", "skills", "implement", "scripts", "check-language.ts")], {
    cwd: dir,
    encoding: "utf8",
  });
  const out = `${r.stdout}${r.stderr}`;
  assert.equal(r.status, 0, out);
  assert.match(out, /src\/visit\.ts \(line 1: session\)/);
  assert.doesNotMatch(out, /\.opencode|\.kataster/);
  assert.match(out, /1 language warning\(s\)/);
});
