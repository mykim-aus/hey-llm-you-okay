/**
 * exec `fingerprint:` — a cheap probe command whose output stands in for the
 * payload fingerprint under --changed-only.
 *
 * WHY (measured on a real project): 40+ LLM harnesses wrapped as exec cases
 * assemble their prompts INSIDE the child process, so heyllm never sees the
 * payload — every changed-only run re-ran the most expensive cases in the
 * suite while the cheap llm-layer cases skipped correctly. The probe prints
 * the harness's real resolved inputs; its hash decides run-vs-skip.
 *
 * Every test pins one property of the promise:
 *   skip IFF (probe output + command) is identical to the last PASSING run —
 *   and a broken probe degrades to "always run", never to "always skip".
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig, runSuite, ConfigError } from "../dist/index.js";

async function scaffold(yaml) {
  const dir = await mkdtemp(path.join(tmpdir(), "heyllm-execfp-"));
  await writeFile(path.join(dir, "heyllm.yaml"), yaml.replaceAll("{{DIR}}", dir));
  return dir;
}
const run = async (dir, opts = {}) => runSuite(await loadConfig(path.join(dir, "heyllm.yaml")), opts);
const caseOf = (s, l, n) => s.layers.find((x) => x.name === l)?.cases.find((c) => c.name === n);
const countLines = async (dir, file) =>
  (await readFile(path.join(dir, file), "utf8").catch(() => "")).split("\n").filter(Boolean).length;

// the case command appends a line per REAL run — "did the expensive thing run?"
// is measured from the file, not inferred from the report.
const CFG = ({ probe, expect = "" }) => `
providers: {}
layers:
  - name: harness
    kind: exec
    cases:
      - name: wrapped
        command: "echo ran >> {{DIR}}/runs.log"
        fingerprint: ${JSON.stringify(probe)}
        ${expect}
`;

test("changed-only: identical probe output skips the second run", async () => {
  const dir = await scaffold(CFG({ probe: "echo stable-prompt" }));
  const s1 = await run(dir, { changedOnly: true });
  assert.equal(caseOf(s1, "harness", "wrapped").result.ok, true);
  assert.equal(await countLines(dir, "runs.log"), 1);

  const s2 = await run(dir, { changedOnly: true });
  const r2 = caseOf(s2, "harness", "wrapped").result;
  assert.equal(r2.ok, true);
  assert.match(r2.skipped || "", /unchanged — fingerprint identical/);
  assert.equal(await countLines(dir, "runs.log"), 1, "the wrapped command must not re-run");
});

test("changed-only: probe output moved → the case re-runs", async () => {
  const dir = await scaffold(CFG({ probe: "cat {{DIR}}/prompt.txt" }));
  await writeFile(path.join(dir, "prompt.txt"), "v1");
  await run(dir, { changedOnly: true });
  assert.equal(await countLines(dir, "runs.log"), 1);

  await writeFile(path.join(dir, "prompt.txt"), "v2 — the prompt was edited");
  const s2 = await run(dir, { changedOnly: true });
  const r2 = caseOf(s2, "harness", "wrapped").result;
  assert.equal(r2.skipped, undefined, "changed inputs must run live");
  assert.equal(await countLines(dir, "runs.log"), 2);
});

test("a broken probe fails OPEN: the case runs, and keeps running", async () => {
  const dir = await scaffold(CFG({ probe: "exit 3" }));
  const s1 = await run(dir, { changedOnly: true });
  const r1 = caseOf(s1, "harness", "wrapped").result;
  assert.equal(r1.ok, true);
  assert.match(r1.changedNote || "", /fingerprint probe failed/);
  assert.equal(await countLines(dir, "runs.log"), 1);

  // no fingerprint was recorded, so the next run cannot skip on a stale one
  const s2 = await run(dir, { changedOnly: true });
  assert.equal(caseOf(s2, "harness", "wrapped").result.skipped, undefined);
  assert.equal(await countLines(dir, "runs.log"), 2);
});

test("without --changed-only the probe itself never runs", async () => {
  const dir = await scaffold(CFG({ probe: "echo probed >> {{DIR}}/probes.log" }));
  await run(dir, {});
  assert.equal(await countLines(dir, "probes.log"), 0, "a normal run must not pay the probe");
  assert.equal(await countLines(dir, "runs.log"), 1);
});

test("record-on-pass: a FAILING case is never skipped as unchanged", async () => {
  const dir = await scaffold(
    CFG({ probe: "echo stable", expect: "expect: { stdout: { $pattern: impossible-output } }" })
  );
  const s1 = await run(dir, { changedOnly: true });
  assert.equal(caseOf(s1, "harness", "wrapped").result.ok, false);

  const s2 = await run(dir, { changedOnly: true });
  const r2 = caseOf(s2, "harness", "wrapped").result;
  assert.equal(r2.skipped, undefined, "a red case must keep re-running until green");
  assert.equal(r2.ok, false);
});

test("fingerprintIgnore blanks volatile probe regions from the hash", async () => {
  const dir = await scaffold(`
providers: {}
layers:
  - name: harness
    kind: exec
    cases:
      - name: wrapped
        command: "echo ran >> {{DIR}}/runs.log"
        fingerprint: "cat {{DIR}}/prompt.txt"
        fingerprintIgnore: ["^TS: .*$"]
`);
  await writeFile(path.join(dir, "prompt.txt"), "stable body\nTS: 2026-07-24T01:00:00Z");
  await run(dir, { changedOnly: true });
  await writeFile(path.join(dir, "prompt.txt"), "stable body\nTS: 2026-07-24T02:00:00Z");
  const s2 = await run(dir, { changedOnly: true });
  assert.match(caseOf(s2, "harness", "wrapped").result.skipped || "", /unchanged/);
  assert.equal(await countLines(dir, "runs.log"), 1);
});

test("an unknown layer kind names the installed version and the upgrade path", async () => {
  const dir = await scaffold(`
providers: {}
layers:
  - name: future
    kind: quantum
    cases: [{ name: x, command: "true" }]
`);
  await assert.rejects(
    () => loadConfig(path.join(dir, "heyllm.yaml")),
    (e) => {
      assert.ok(e instanceof ConfigError);
      assert.match(e.message, /'quantum' is not valid/);
      assert.match(e.message, /installed heyllm \d+\.\d+\.\d+/);
      assert.match(e.message, /npm i -D hey-llm-you-okay@latest/);
      return true;
    }
  );
});
