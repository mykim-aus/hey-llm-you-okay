/**
 * Token metering — the rollup invariants (unmetered/unsplit/floor) and the
 * end-to-end flow through runSuite against the mock LLM (which now returns
 * deterministic usage).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig, runSuite, summarizeUsage } from "../dist/index.js";
import { startMockLLM } from "./mock-llm.js";

// ── unit: summarizeUsage invariants ──────────────────────────────────────────
const ev = (usage) => ({ layer: "l", phase: "run", provider: "p", kind: "openai-compatible", model: "m", usage });

test("summarizeUsage: a call with no usage is unmetered, never counted as 0", () => {
  const t = summarizeUsage([ev(undefined), ev({ inputTokens: 100, outputTokens: 20, totalTokens: 120 })]);
  assert.equal(t.calls, 2);
  assert.equal(t.unmetered, 1);
  assert.equal(t.inputTokens, 100, "the unmetered call must not add a phantom 0 that hides the floor");
  assert.equal(t.complete, false, "any unmetered call makes the totals a floor");
});

test("summarizeUsage: a total-only response is unsplit and does not inflate in/out", () => {
  const t = summarizeUsage([ev({ totalTokens: 500 })]);
  assert.equal(t.unsplit, 1);
  assert.equal(t.totalTokens, 500);
  assert.equal(t.inputTokens, 0);
  assert.equal(t.outputTokens, 0);
  assert.equal(t.complete, false);
});

test("summarizeUsage: fully-metered calls are complete and bucketed by provider+model", () => {
  const t = summarizeUsage([
    ev({ inputTokens: 10, outputTokens: 2, totalTokens: 12 }),
    ev({ inputTokens: 30, outputTokens: 4, totalTokens: 34 }),
  ]);
  assert.equal(t.complete, true);
  assert.equal(t.inputTokens, 40);
  assert.equal(t.outputTokens, 6);
  assert.equal(t.buckets.length, 1);
  assert.equal(t.buckets[0].calls, 2);
});

// ── integration: usage flows through runSuite ────────────────────────────────
let mock;
test.before(async () => (mock = await startMockLLM()));
test.after(async () => mock.close());

async function scaffold(yaml) {
  const dir = await mkdtemp(path.join(tmpdir(), "heyllm-usage-"));
  await writeFile(path.join(dir, "heyllm.yaml"), yaml.replaceAll("{{MOCK}}", mock.base));
  return dir;
}

test("runSuite attaches usage at run, layer and case level for a metered provider", async () => {
  const dir = await scaffold(`
providers:
  subject: { kind: openai-compatible, baseUrl: "{{MOCK}}", model: mock, apiKeyEnv: X }
layers:
  - name: behavior
    kind: llm
    provider: subject
    cases:
      - { name: echo, prompt: "say hi", expect: { text: "" } }
`);
  process.env.X = "x";
  const s = await runSuite(await loadConfig(path.join(dir, "heyllm.yaml")));
  assert.ok(s.usage, "run-level usage present");
  assert.ok(s.usage.inputTokens > 0, "input tokens were metered");
  assert.equal(s.usage.calls, 1);
  const layer = s.layers.find((l) => l.name === "behavior");
  assert.ok(layer.usage && layer.usage.calls === 1, "layer-level usage present");
  const c = layer.cases.find((x) => x.name === "echo");
  assert.ok(c.usage && c.usage.inputTokens > 0, "case-level usage present");
});

test("a static-only run carries NO usage key (not an all-zero object)", async () => {
  const dir = await scaffold(`
providers: {}
layers:
  - name: s
    kind: static
    cases:
      - { name: exists, file: heyllm.yaml, mustExist: true }
`);
  const s = await runSuite(await loadConfig(path.join(dir, "heyllm.yaml")));
  assert.equal(s.usage, undefined, "no model calls ⇒ no usage key at all");
  assert.equal(s.layers[0].usage, undefined);
});

// ── regressions from the 0.1.8 adversarial audit ─────────────────────────────

test("REGRESSION: non-numeric usage values never reach the totals", () => {
  // A provider returning strings used to be concatenated: "012001200 in".
  const t = summarizeUsage([ev({ inputTokens: "1200", outputTokens: "12", totalTokens: "1212" })]);
  assert.equal(t.inputTokens, 1200, "numeric strings are coerced, not concatenated");
  assert.equal(typeof t.inputTokens, "number");
  const junk = summarizeUsage([ev({ inputTokens: "n/a", outputTokens: null })]);
  assert.equal(junk.unmetered, 1, "unparseable usage is unmetered, not a phantom 0");
  assert.equal(junk.complete, false);
});

test("REGRESSION: a half-reported split is not 'complete' with a phantom zero", () => {
  const t = summarizeUsage([ev({ inputTokens: 500 })]); // output absent
  assert.equal(t.complete, false, "one half of the split is not a complete measurement");
  assert.equal(t.unsplit, 1);
});

test("REGRESSION: a call that threw is recorded as unmetered, not omitted", async () => {
  const { TokenMeter } = await import("../dist/usage.js");
  const meter = new TokenMeter();
  const failing = { name: "p", kind: "openai-compatible", model: "m", chat: async () => { throw new Error("boom"); } };
  const scoped = meter.scope({ layer: "l", phase: "run" }, { p: failing });
  await assert.rejects(() => scoped.p.chat({ messages: [] }));
  const t = summarizeUsage(meter.all());
  assert.equal(t.calls, 1, "the call happened and may have been billed");
  assert.equal(t.unmetered, 1);
  assert.equal(t.complete, false, "omitting failed calls used to claim a complete measurement");
});
