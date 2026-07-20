import test from "node:test";
import assert from "node:assert/strict";
import { matchValue, applyExpect } from "../dist/index.js";

const failuresOf = (spec, got) => {
  const f = [];
  matchValue(spec, got, "x", f);
  return f;
};

test("primitives: strict equality", () => {
  assert.equal(failuresOf(200, 200).length, 0);
  assert.equal(failuresOf(200, "200").length, 1);
});

test("$pattern / $notPattern / $flags", () => {
  assert.equal(failuresOf({ $pattern: "^hel+o" }, "helllo world").length, 0);
  assert.equal(failuresOf({ $pattern: "^HELLO", $flags: "i" }, "hello").length, 0);
  assert.equal(failuresOf({ $notPattern: "error" }, "all good").length, 0);
  assert.equal(failuresOf({ $notPattern: "error" }, "an error!").length, 1);
});

test("$in / $gt / $lte / $exists / $type", () => {
  assert.equal(failuresOf({ $in: [1, 2, 3] }, 2).length, 0);
  assert.equal(failuresOf({ $in: [1, 2] }, 5).length, 1);
  assert.equal(failuresOf({ $gt: 5, $lte: 10 }, 7).length, 0);
  assert.equal(failuresOf({ $gt: 5 }, 3).length, 1);
  assert.equal(failuresOf({ $exists: true }, "v").length, 0);
  assert.equal(failuresOf({ $exists: false }, undefined).length, 0);
  assert.equal(failuresOf({ $type: "array" }, [1]).length, 0);
});

test("$contains on strings and arrays (all needles required)", () => {
  assert.equal(failuresOf({ $contains: "wor" }, "hello world").length, 0);
  assert.equal(failuresOf({ $contains: ["a", "b"] }, ["a", "b", "c"]).length, 0);
  assert.equal(failuresOf({ $contains: ["a", "z"] }, ["a", "b"]).length, 1);
  assert.equal(failuresOf({ $notContains: "secret" }, "public text").length, 0);
});

test("object literals are deep subsets; extra keys in got are fine", () => {
  assert.equal(failuresOf({ a: { b: 1 } }, { a: { b: 1, c: 2 }, d: 3 }).length, 0);
  assert.equal(failuresOf({ a: { b: 2 } }, { a: { b: 1 } }).length, 1);
});

test("matchers nest inside literals", () => {
  assert.equal(failuresOf({ user: { name: { $pattern: "^k" } } }, { user: { name: "kim" } }).length, 0);
});

test("$any / $all combinators", () => {
  assert.equal(failuresOf({ $any: [1, 2, { $gt: 10 }] }, 42).length, 0);
  assert.equal(failuresOf({ $any: [1, 2] }, 3).length, 1);
  assert.equal(failuresOf({ $all: [{ $gt: 1 }, { $lt: 10 }] }, 5).length, 0);
});

test("applyExpect: jsonPath + text string shorthand + unknown key fails loudly", () => {
  const actual = { status: 200, json: { data: { type: "study" } }, text: "hello world" };
  const f1 = applyExpect({ status: 200, jsonPath: { "data.type": "study" }, text: "world" }, actual, []);
  assert.equal(f1.length, 0);
  const f2 = applyExpect({ statsu: 200 }, actual, []); // typo must not silently pass
  assert.equal(f2.length, 1);
  assert.match(f2[0].message, /unknown expect key/);
});
