import assert from "node:assert/strict";
import { test } from "node:test";
import { addProperty, appendItems, nodeValue, parseTree } from "../src/jsonc.mjs";
import { parseJsonc } from "../src/util.mjs";

const commented = `{
  // The model this project uses.
  "model": "x/y", // pinned on purpose

  /* Rules: ours last. */
  "permissions": [
    { "action": "shell", "resource": "*", "effect": "ask" }, // catch-all
  ],
  "watcher": {
    "ignore": [
      "tmp/**" // scratch
    ]
  }
}
`;

test("parseTree reads JSONC: comments, trailing commas, nesting", () => {
  assert.deepEqual(nodeValue(parseTree(commented)), parseJsonc(commented));
  assert.deepEqual(nodeValue(parseTree('{"a": "// not a comment", "b": "/* nor this */"}')), {
    a: "// not a comment",
    b: "/* nor this */",
  });
  assert.throws(() => parseTree('{"a": 1} trailing'), SyntaxError);
  assert.throws(() => parseTree("{'a': 1}"), SyntaxError);
  assert.throws(() => parseTree('{"a": 1 /* open'), SyntaxError);
});

test("addProperty keeps every comment and line, and adds nothing when the key exists", () => {
  const next = addProperty(commented, [], "automations", false);
  assert.equal(next, commented.replace('    ]\n  }\n}', '    ]\n  },\n  "automations": false\n}'));
  assert.equal(addProperty(next, [], "automations", true), next, "an existing key is the project's choice");
  assert.equal(addProperty(next, ["model"], "x", 1), next, "a path that is not an object changes nothing");
});

test("appendItems keeps a comment on the last member's line and the trailing comma", () => {
  const next = appendItems(commented, ["permissions"], [{ action: "shell", resource: "git *", effect: "allow" }]);
  assert.match(
    next,
    /"effect": "ask" \}, \/\/ catch-all\n {4}\{ "action": "shell", "resource": "git \*", "effect": "allow" \},\n {2}\],/,
  );
  const ignore = appendItems(commented, ["watcher", "ignore"], ["dist/**"]);
  assert.match(ignore, /"tmp\/\*\*", \/\/ scratch\n {6}"dist\/\*\*"\n {4}\]/);
  assert.deepEqual(parseJsonc(ignore).watcher.ignore, ["tmp/**", "dist/**"]);
  assert.equal(appendItems(commented, ["permissions"], []), commented);
});

test("multi-line values take the indentation of their position; one-line files stay one line", () => {
  const nested = addProperty(commented, ["watcher"], "rules", { deep: [1, 2] });
  assert.match(nested, /\n {4}"rules": \{\n {6}"deep": \[\n {8}1,/);
  assert.deepEqual(parseJsonc(nested).watcher.rules, { deep: [1, 2] });

  assert.equal(addProperty('{"a":1}', [], "b", { c: [1] }), '{"a":1, "b": { "c": [1] }}');
  assert.equal(appendItems("{\n\t\"p\": []\n}", ["p"], ["x"]), '{\n\t"p": [\n\t\t"x"\n\t]\n}');
  assert.equal(addProperty("{}", [], "a", 1), '{\n  "a": 1\n}');
});
