/**
 * Input-provenance contract (F2). The load-bearing test is that the contract
 * fires on `heyllm run`, not only on `heyllm validate` — a check that lives
 * only in the validator does nothing on the ordinary run path.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig, runSuite, loadLayerCases, validateCases } from "../dist/index.js";
import { systemSource, checkInputContract, censusSystemSources, formatSystemCensus } from "../dist/inputs.js";
import { startMockLLM } from "./mock-llm.js";

// ── unit ─────────────────────────────────────────────────────────────────────
test("systemSource classifies exec/file/inline/absent, judge nests under input", () => {
  assert.equal(systemSource({ system: "exec:build.js" }, "llm"), "exec");
  assert.equal(systemSource({ system: "file:p.txt" }, "llm"), "file");
  assert.equal(systemSource({ system: "You are a bot" }, "llm"), "inline");
  assert.equal(systemSource({}, "llm"), "absent");
  assert.equal(systemSource({ input: { system: "exec:x" } }, "judge"), "exec");
});

test("census counts by source, closest-to-production first", () => {
  const cases = [{ system: "exec:a" }, { system: "exec:b" }, { system: "hi" }, {}];
  const counts = censusSystemSources("llm", cases);
  assert.deepEqual(counts, { exec: 2, file: 0, inline: 1, absent: 1 });
  assert.equal(formatSystemCensus(counts), "2 exec, 1 inline, 1 absent");
});

test("checkInputContract: exec contract rejects an inline literal", () => {
  const layer = { name: "l", kind: "llm", inputs: { system: "exec" } };
  const fails = checkInputContract({ system: "You are a bot" }, { system: "You are a bot" }, layer);
  assert.equal(fails.length, 1);
  assert.match(fails[0].message, /inputs.system: exec/);
});

test("checkInputContract: a file ref that resolved empty fails unconditionally (no contract)", () => {
  const layer = { name: "l", kind: "llm" }; // NO inputs contract at all
  const fails = checkInputContract({ system: "file:p.txt" }, { system: "   " }, layer);
  assert.equal(fails.length, 1, "the 0-byte floor needs no opt-in");
  assert.match(fails[0].message, /0 bytes|program you do not ship/);
});

test("checkInputContract: satisfied contract passes clean", () => {
  const layer = { name: "l", kind: "llm", inputs: { system: "exec" } };
  assert.equal(checkInputContract({ system: "exec:build.js" }, { system: "a real prompt" }, layer).length, 0);
});

// ── integration: THE contract fires on run, not just validate ─────────────────
let mock;
test.before(async () => (mock = await startMockLLM()));
test.after(async () => mock.close());

async function scaffold(yaml, files = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "heyllm-inputs-"));
  await writeFile(path.join(dir, "heyllm.yaml"), yaml.replaceAll("{{MOCK}}", mock.base));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, content);
  }
  return dir;
}

test("a layer with inputs:{system:exec} FAILS on run when a case sends no system prompt", async () => {
  const dir = await scaffold(`
providers:
  subject: { kind: openai-compatible, baseUrl: "{{MOCK}}", model: mock, apiKeyEnv: X }
layers:
  - name: routing
    kind: llm
    provider: subject
    inputs: { system: exec }
    cases:
      - { name: bare, prompt: "hi", expect: { text: "" } }
`);
  process.env.X = "x";
  const s = await runSuite(await loadConfig(path.join(dir, "heyllm.yaml")));
  const c = s.layers[0].cases[0];
  assert.equal(c.result.ok, false, "the incident case (no system prompt) must not pass");
  assert.match(c.result.failures[0].message, /inputs.system: exec/);
  // and it costs zero tokens — the check short-circuits before the model call
  assert.ok(!c.usage || c.usage.calls === 0, "a contract miss must not spend tokens");
});

test("the same case passes when it sends an exec-built system prompt", async () => {
  const dir = await scaffold(`
providers:
  subject: { kind: openai-compatible, baseUrl: "{{MOCK}}", model: mock, apiKeyEnv: X }
layers:
  - name: routing
    kind: llm
    provider: subject
    inputs: { system: exec }
    cases:
      - { name: ok, system: "exec:printf 'You are the production assistant'", prompt: "hi", expect: { text: "" } }
`);
  process.env.X = "x";
  const s = await runSuite(await loadConfig(path.join(dir, "heyllm.yaml")));
  assert.equal(s.layers[0].cases[0].result.ok, true);
});

test("validateCases flags a bad inputs.system mode and an unsatisfiable case", async () => {
  const dir = await scaffold(`
providers:
  subject: { kind: openai-compatible, baseUrl: "{{MOCK}}", model: mock, apiKeyEnv: X }
layers:
  - name: routing
    kind: llm
    provider: subject
    inputs: { system: exec }
    cases:
      - { name: bare, prompt: "hi", expect: { text: "" } }
`);
  const config = await loadConfig(path.join(dir, "heyllm.yaml"));
  const layer = config.layers[0];
  const groups = await loadLayerCases(layer, config.baseDir);
  const problems = validateCases(layer, groups);
  assert.ok(problems.some((p) => /inputs.system: exec/.test(p)), "validate must also catch the inline/absent case");
});

test("a static-only layer with an inputs key is a config error", async () => {
  const dir = await scaffold(`
providers: {}
layers:
  - name: s
    kind: static
    inputs: { system: exec }
    cases:
      - { name: x, file: heyllm.yaml }
`);
  await assert.rejects(() => loadConfig(path.join(dir, "heyllm.yaml")), /only applies to llm\/judge/);
});
