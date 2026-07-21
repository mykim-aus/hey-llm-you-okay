/**
 * --max-spend: a soft token budget. Once cumulative spend crosses it, remaining
 * PAID (llm/judge) cases are skipped instead of run. Deterministic layers are
 * never affected.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig, runSuite } from "../dist/index.js";
import { startMockLLM } from "./mock-llm.js";

let mock;
test.before(async () => { mock = await startMockLLM(); });
test.after(async () => { await mock.close(); });

const scaffold = async (files) => {
  const dir = await mkdtemp(path.join(tmpdir(), "heyllm-budget-"));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, content.replaceAll("{{MOCK}}", mock.base));
  }
  return dir;
};

test("paid cases past the budget are skipped, not run", async () => {
  const dir = await scaffold({
    "heyllm.yaml": `
providers:
  m: { kind: openai-compatible, baseUrl: "{{MOCK}}/v1", model: mock-1 }
layers:
  - name: paid
    kind: llm
    provider: m
    gate: false
    concurrency: 1
    cases:
      - { name: c1, prompt: "one", expect: { text: { $contains: "echo" } } }
      - { name: c2, prompt: "two", expect: { text: { $contains: "echo" } } }
      - { name: c3, prompt: "three", expect: { text: { $contains: "echo" } } }
`,
  });
  const before = mock.state.requests.length;
  const s = await runSuite(await loadConfig(path.join(dir, "heyllm.yaml")), { maxSpend: 1 });
  const calls = mock.state.requests.length - before;
  const cases = s.layers[0].cases;
  // c1 ran and spent tokens; the budget (1) is then exceeded, so c2/c3 skip
  assert.equal(calls, 1, "only the first paid case reached the model");
  assert.equal(cases[0].result.skipped, undefined, "c1 ran");
  assert.match(cases[1].result.skipped || "", /max-spend/);
  assert.match(cases[2].result.skipped || "", /max-spend/);
  assert.equal(s.ok, true, "a budget cap is not a failure");
});

test("[review#3] a total-only usage response still trips the budget (no fail-open)", async () => {
  // The model reports only total_tokens (no in/out split). If spend were counted
  // as inputTokens+outputTokens, it would read 0 and the budget would NEVER trip —
  // paid cases would keep running past the cap. spend() must fall back to totalTokens.
  const dir = await scaffold({
    "heyllm.yaml": `
providers:
  m: { kind: openai-compatible, baseUrl: "{{MOCK}}/v1", model: mock-1 }
layers:
  - name: paid
    kind: llm
    provider: m
    gate: false
    concurrency: 1
    cases:
      - { name: c1, prompt: "one", expect: { text: { $contains: "echo" } } }
      - { name: c2, prompt: "two", expect: { text: { $contains: "echo" } } }
      - { name: c3, prompt: "three", expect: { text: { $contains: "echo" } } }
`,
  });
  mock.state.totalOnly = true;
  try {
    const before = mock.state.requests.length;
    const s = await runSuite(await loadConfig(path.join(dir, "heyllm.yaml")), { maxSpend: 1 });
    const calls = mock.state.requests.length - before;
    assert.equal(calls, 1, "budget must trip on total-only usage — only c1 reaches the model");
    assert.match(s.layers[0].cases[1].result.skipped || "", /max-spend/);
    assert.match(s.layers[0].cases[2].result.skipped || "", /max-spend/);
  } finally {
    mock.state.totalOnly = false;
  }
});

test("no --max-spend runs everything", async () => {
  const dir = await scaffold({
    "heyllm.yaml": `
providers:
  m: { kind: openai-compatible, baseUrl: "{{MOCK}}/v1", model: mock-1 }
layers:
  - name: paid
    kind: llm
    provider: m
    gate: false
    concurrency: 1
    cases:
      - { name: c1, prompt: "one", expect: { text: { $contains: "echo" } } }
      - { name: c2, prompt: "two", expect: { text: { $contains: "echo" } } }
`,
  });
  const s = await runSuite(await loadConfig(path.join(dir, "heyllm.yaml")), {});
  assert.ok(s.layers[0].cases.every((c) => !c.result.skipped), "no case skipped without a budget");
});
