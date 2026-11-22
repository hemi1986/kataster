import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { toolIgnoreGaps } from "../src/tool-ignores.mjs";

function repo(files) {
  const dir = mkdtempSync(join(tmpdir(), "kataster-ignores-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content, "utf8");
  }
  return dir;
}

const byTool = (gaps) => Object.fromEntries(gaps.map((gap) => [gap.tool, gap]));

test("configs that would check Kataster's files are reported with the missing entries", () => {
  const gaps = byTool(toolIgnoreGaps(repo({
    "package.json": "{}",
    ".prettierrc": "{}",
    ".prettierignore": "dist/\n",
    "eslint.config.js": "export default [{ ignores: ['dist/**'] }];\n",
    "tsconfig.json": '{ "compilerOptions": {} }',
  })));
  assert.deepEqual(Object.keys(gaps).sort(), ["ESLint", "Prettier", "TypeScript"]);
  assert.ok(gaps.Prettier.missing.includes(".claude/") && gaps.Prettier.missing.includes("AGENTS.md"));
  assert.deepEqual(gaps.ESLint.missing, [".claude/", ".opencode/"]);
  assert.match(gaps.TypeScript.hint, /"exclude": \[".claude", ".opencode"\]/);
});

test("configs that already exclude the paths are not reported", () => {
  const gaps = toolIgnoreGaps(repo({
    "package.json": JSON.stringify({ prettier: { singleQuote: true } }),
    ".prettierignore": "/.claude/**\n.opencode\nAGENTS.md\nCLAUDE.md\ndocs/\n",
    "eslint.config.mjs": "export default [{ ignores: ['.claude/**', '.opencode/**'] }];\n",
    "tsconfig.json": '{ "include": ["src"] }',
  }));
  assert.deepEqual(gaps, []);
});

test("legacy ESLint reads .eslintignore, and a project without tools gets no hint", () => {
  const legacy = toolIgnoreGaps(repo({ "package.json": "{}", ".eslintrc.json": "{}", ".eslintignore": ".claude/\n" }));
  assert.deepEqual(legacy.map((gap) => [gap.tool, gap.missing]), [["ESLint", [".opencode/"]]]);
  assert.deepEqual(toolIgnoreGaps(repo({ "package.json": "{}" })), []);
});
