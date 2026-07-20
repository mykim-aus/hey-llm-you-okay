/**
 * Self-Growing Corpus Ledger: capture appends a runnable case; the next
 * `haechi run` picks it up through the layer's include glob.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig, runSuite, captureCase } from "../dist/index.js";
import { startMockLLM } from "./mock-llm.js";

let mock;
test.before(async () => {
  mock = await startMockLLM();
});
test.after(async () => {
  await mock.close();
});

test("capture appends to the ledger with defaults; next run executes it", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "haechi-cap-"));
  await writeFile(
    path.join(dir, "haechi.yaml"),
    `
providers:
  m: { kind: openai-compatible, baseUrl: "${mock.base}/v1", model: mock-1 }
settings:
  capture:
    file: tests/captured.yaml
    defaults:
      expect: { text: { $notPattern: "DRIFTED", $flags: "i" } }
layers:
  - name: b
    kind: llm
    provider: m
    gate: false
    include: tests/*.yaml
`
  );
  await mkdir(path.join(dir, "tests"), { recursive: true });
  await writeFile(path.join(dir, "tests/base.yaml"), `cases: [{ name: base, prompt: hi, expect: { text: echo } }]`);

  const config = await loadConfig(path.join(dir, "haechi.yaml"));
  const res = await captureCase(config, "프로덕션에서 오탐이 났던 문장입니다", {
    tags: ["prod-report"],
    note: "user #4821 complaint",
  });
  assert.match(res.caseName, /^captured-\d{8}-01$/);

  const ledger = await readFile(res.file, "utf8");
  assert.match(ledger, /prod-report/);
  assert.match(ledger, /오탐이 났던 문장/);

  // second capture same day → -02
  const res2 = await captureCase(config, "두 번째 수집", {});
  assert.match(res2.caseName, /-02$/);

  // the ledger is immediately part of the pyramid
  const summary = await runSuite(await loadConfig(path.join(dir, "haechi.yaml")));
  const names = summary.layers[0].cases.map((c) => c.name);
  assert.ok(names.includes(res.caseName), JSON.stringify(names));
  const captured = summary.layers[0].cases.find((c) => c.name === res.caseName);
  assert.equal(captured.result.ok, true, JSON.stringify(captured.result.failures)); // echo ≠ DRIFTED
});
