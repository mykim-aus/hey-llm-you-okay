/**
 * compare: integration through runSuite + the static layer — ref resolution,
 * the empty/mixed-type/exit-code guards, and validateCases rejection paths.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig, runSuite, loadLayerCases, validateCases } from "../dist/index.js";

async function scaffold(files) {
  const dir = await mkdtemp(path.join(tmpdir(), "heyllm-cmp-"));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, content);
  }
  return dir;
}
const run = async (dir) => runSuite(await loadConfig(path.join(dir, "heyllm.yaml")));
const caseOf = (s, layer, name) => s.layers.find((l) => l.name === layer)?.cases.find((c) => c.name === name);

const CONFIG = (cs) => `
providers: {}
layers:
  - name: s
    kind: static
    cases:
${cs}
`;

test("compare: file: with trailing newline vs exec: (trimmed) PASSES normalized, FAILS exact", async () => {
  // resolveRef trims exec: output but returns file: text raw — the day-one
  // false alarm that the normalized default exists to prevent.
  const files = {
    "prompt.txt": "hello\nworld\n", // trailing newline
    "build.sh": "printf 'hello\\nworld'\n", // no trailing newline, exec trims anyway
  };
  const normalized = await scaffold({
    ...files,
    "heyllm.yaml": CONFIG(
      `      - name: cmp
        compare: { left: file:prompt.txt, right: "exec:sh build.sh", mode: normalized }`
    ),
  });
  let s = await run(normalized);
  assert.equal(caseOf(s, "s", "cmp").result.ok, true, "trailing-newline-only diff must pass under normalized");
  assert.equal(caseOf(s, "s", "cmp").result.detail.bytesIdentical, false, "green run still reports it waived bytes");

  const exact = await scaffold({
    ...files,
    "heyllm.yaml": CONFIG(
      `      - name: cmp
        compare: { left: file:prompt.txt, right: "exec:sh build.sh", mode: exact }`
    ),
  });
  s = await run(exact);
  assert.equal(caseOf(s, "s", "cmp").result.ok, false, "same diff must fail under exact");
});

test("compare: a real difference emits ONE failure with path 'compare' and a compareReport", async () => {
  const dir = await scaffold({
    "prod.txt": "## a\nx\n## b\ny\n## c\nz\n",
    "test.txt": "## a\nx\n",
    "heyllm.yaml": CONFIG(
      `      - name: cmp
        compare: { left: file:prod.txt, right: file:test.txt }`
    ),
  });
  const s = await run(dir);
  const r = caseOf(s, "s", "cmp").result;
  assert.equal(r.ok, false);
  assert.equal(r.failures.length, 1, "exactly one failure — console prints only 6");
  assert.equal(r.failures[0].path, "compare");
  assert.ok(r.compareReport, "the multi-line report is attached");
  assert.match(r.compareReport, /only in prod\.txt/);
});

test("compare: an exec: side that exits non-zero fails with path compare.left, exit 1 not 2", async () => {
  const dir = await scaffold({
    "test.txt": "x",
    "heyllm.yaml": CONFIG(
      `      - name: cmp
        compare: { left: "exec:sh -c 'exit 3'", right: file:test.txt }`
    ),
  });
  const s = await run(dir);
  const r = caseOf(s, "s", "cmp").result;
  assert.equal(r.ok, false);
  assert.equal(r.failures[0].path, "compare.left");
  assert.ok(!s.infra || !s.infra.length, "a broken build script is exit 1, not an infra fault (exit 2)");
});

test("compare: an empty resolved side fails loudly — verified nothing", async () => {
  const dir = await scaffold({
    "empty.txt": "   \n  \n",
    "test.txt": "   \n",
    "heyllm.yaml": CONFIG(
      `      - name: cmp
        compare: { left: file:empty.txt, right: file:test.txt }`
    ),
  });
  const s = await run(dir);
  const r = caseOf(s, "s", "cmp").result;
  assert.equal(r.ok, false, "two empty sides must not report a green compare");
  assert.match(r.failures[0].message, /empty|verified nothing/i);
});

test("compare: a .json side (parsed to an object) fails with a typed error, not a diff", async () => {
  const dir = await scaffold({
    "data.json": '{"a":1}',
    "text.txt": "some text",
    "heyllm.yaml": CONFIG(
      `      - name: cmp
        compare: { left: file:data.json, right: file:text.txt }`
    ),
  });
  const s = await run(dir);
  const r = caseOf(s, "s", "cmp").result;
  assert.equal(r.ok, false);
  assert.match(r.failures[0].message, /text refs|resolved to/);
});

test("validateCases: compare alongside forbid, bad mode, and bare paths are all problems", async () => {
  const dir = await scaffold({
    "heyllm.yaml": CONFIG(
      `      - name: clash
        compare: { left: file:a, right: file:b }
        forbid: ["X"]
      - name: badmode
        compare: { left: file:a, right: file:b, mode: fuzzy }
      - name: barepath
        compare: { left: prompts/x, right: file:b }`
    ),
  });
  const config = await loadConfig(path.join(dir, "heyllm.yaml"));
  const layer = config.layers[0];
  const groups = await loadLayerCases(layer, config.baseDir);
  const problems = validateCases(layer, groups);
  assert.ok(problems.some((p) => /clash.*cannot be combined with forbid/s.test(p)), "compare+forbid must be flagged");
  assert.ok(problems.some((p) => /badmode.*not valid.*exact, normalized/s.test(p)), "bad mode must list valid modes");
  assert.ok(problems.some((p) => /barepath.*file: or exec: ref/s.test(p)), "bare path must be flagged");
});
