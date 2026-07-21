/**
 * --changed-only: skip llm/judge cases whose resolved payload is unchanged, and
 * run the rest. Every test here pins one property of the same promise — a case
 * is skipped IF AND ONLY IF the exact thing sent to the model is identical to
 * its last passing run, and a skip is never laundered into a pass.
 *
 * The mock records every request (`mock.state.requests`), so "was the model
 * actually called?" is measured, not inferred — a changed-only skip that still
 * makes the paid call would defeat the whole feature and must fail a test.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig, runSuite } from "../dist/index.js";
import { startMockLLM } from "./mock-llm.js";

let mock;
test.before(async () => {
  mock = await startMockLLM();
});
test.after(async () => {
  await mock.close();
});

async function scaffold(configYaml, files = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "heyllm-changed-"));
  await writeFile(path.join(dir, "heyllm.yaml"), configYaml.replaceAll("{{MOCK}}", mock.base));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, content.replaceAll("{{MOCK}}", mock.base));
  }
  return dir;
}

const run = async (dir, opts = {}) => runSuite(await loadConfig(path.join(dir, "heyllm.yaml")), opts);
const caseOf = (s, layer, name) =>
  s.layers.find((l) => l.name === layer)?.cases.find((c) => c.name === name);
const store = async (dir) => JSON.parse(await readFile(path.join(dir, ".heyllm/prompts.json"), "utf8"));

/** run + return how many model calls it made (mock request log is cumulative) */
async function runCounting(dir, opts = {}) {
  const before = mock.state.requests.length;
  const s = await run(dir, opts);
  return { s, calls: mock.state.requests.length - before };
}

const CFG = (extra = "") => `
providers:
  m: { kind: openai-compatible, baseUrl: "{{MOCK}}/v1", model: mock-1 }
layers:
  - name: b
    kind: llm
    provider: m
    cases:
      - name: greet
        system: "SAY: hello"
        prompt: "hi"
        expect: { text: { $contains: hello } }
${extra}`;

test("first run records the fingerprint; a normal run has no store yet to skip on", async () => {
  const dir = await scaffold(CFG());
  const { s, calls } = await runCounting(dir);
  assert.equal(caseOf(s, "b", "greet").result.ok, true);
  assert.equal(calls, 1, "the case actually ran once");
  const st = await store(dir);
  assert.ok(st.cases["b/greet"]?.fp, "fingerprint recorded for the passing case");
  assert.ok(st.lastFullRunAt, "an unfiltered run stamps lastFullRunAt");
});

test("--changed-only skips an unchanged case WITHOUT calling the model", async () => {
  const dir = await scaffold(CFG());
  await run(dir); // populate
  const { s, calls } = await runCounting(dir, { changedOnly: true });
  const r = caseOf(s, "b", "greet").result;
  assert.ok(r.skipped, "unchanged case is skipped");
  assert.match(r.skipped, /unchanged/);
  assert.equal(calls, 0, "no paid call was made for the skipped case");
  // A skip is NOT a pass: the reporter counts it separately (verified in the
  // console reporter's own logic — here we assert the shape it keys off).
  assert.equal(r.ok, true); // ok:true so it does not fail the gate...
  assert.ok(r.skipped); // ...but skipped is set so it is not counted as passed
});

test("a changed SYSTEM prompt re-runs under --changed-only", async () => {
  const dir = await scaffold(CFG());
  await run(dir); // record fp for "SAY: hello"
  // edit the prompt in place
  await writeFile(
    path.join(dir, "heyllm.yaml"),
    CFG().replace("SAY: hello", "SAY: howdy").replaceAll("{{MOCK}}", mock.base)
  );
  const { s, calls } = await runCounting(dir, { changedOnly: true });
  const r = caseOf(s, "b", "greet").result;
  assert.ok(!r.skipped, "a changed prompt is not skipped");
  assert.equal(calls, 1, "the changed case actually re-ran");
  // and the expect still matches the new SAY word? no — expect wants "hello",
  // model now says "howdy", so this run fails. That is correct: changed → run →
  // real verdict. The point is it was NOT skipped.
  assert.equal(r.ok, false);
});

test("a changed TOOL declaration re-runs — the case a file-diff of prompts would miss", async () => {
  const dir = await scaffold(CFG("        tools: file:tools.json"), {
    "tools.json": JSON.stringify([
      { name: "get_x", description: "old description", parameters: { type: "object", properties: {} } },
    ]),
  });
  await run(dir); // record fp incl. tool declarations
  const s1 = await runCounting(dir, { changedOnly: true });
  assert.ok(caseOf(s1.s, "b", "greet").result.skipped, "unchanged tools → skipped");

  // Only the tool DESCRIPTION changes — no prompt file touched at all.
  await writeFile(
    path.join(dir, "tools.json"),
    JSON.stringify([
      { name: "get_x", description: "NEW description", parameters: { type: "object", properties: {} } },
    ])
  );
  const s2 = await runCounting(dir, { changedOnly: true });
  assert.ok(!caseOf(s2.s, "b", "greet").result.skipped, "a tool-description change re-runs");
  assert.equal(s2.calls, 1);
});

test("a changed MODEL re-runs even with byte-identical prompt and tools", async () => {
  const dir = await scaffold(CFG());
  await run(dir);
  await writeFile(
    path.join(dir, "heyllm.yaml"),
    CFG().replace("model: mock-1", "model: mock-2").replaceAll("{{MOCK}}", mock.base)
  );
  const { s, calls } = await runCounting(dir, { changedOnly: true });
  assert.ok(!caseOf(s, "b", "greet").result.skipped, "a model bump re-runs the case");
  assert.equal(calls, 1);
});

test("--always forces a layer to run every time regardless of fingerprint", async () => {
  const dir = await scaffold(CFG());
  await run(dir);
  const { s, calls } = await runCounting(dir, { changedOnly: true, always: ["b"] });
  assert.ok(!caseOf(s, "b", "greet").result.skipped, "an --always layer is never skipped");
  assert.equal(calls, 1);
});

test("record-on-pass: a FAILING case is never skipped as unchanged", async () => {
  // expect wants a word the model never says → the case fails every run.
  const dir = await scaffold(`
providers:
  m: { kind: openai-compatible, baseUrl: "{{MOCK}}/v1", model: mock-1 }
layers:
  - name: b
    kind: llm
    provider: m
    cases:
      - name: broken
        system: "SAY: hello"
        prompt: "hi"
        expect: { text: { $contains: NEVER_SAID } }
`);
  const first = await runCounting(dir);
  assert.equal(caseOf(first.s, "b", "broken").result.ok, false, "case fails");
  // failing case must NOT have been recorded
  const st = await store(dir).catch(() => ({ cases: {} }));
  assert.ok(!st.cases["b/broken"], "a failing case is not written to the store");
  // so under --changed-only it re-runs rather than being skipped
  const second = await runCounting(dir, { changedOnly: true });
  assert.ok(!caseOf(second.s, "b", "broken").result.skipped, "a red case keeps re-running");
  assert.equal(second.calls, 1);
});

test("judge input: cases skip on unchanged subject+rubric and skip the paid calls", async () => {
  const dir = await scaffold(`
providers:
  m: { kind: openai-compatible, baseUrl: "{{MOCK}}/v1", model: mock-subject }
  j: { kind: openai-compatible, baseUrl: "{{MOCK}}/v1", model: mock-judge }
layers:
  - name: q
    kind: judge
    subject: m
    judge: j
    votes: 2
    threshold: 5
    cases:
      - name: graded
        input: { system: "SAY: hello", prompt: "hi" }
        rubric:
          - { id: nice, question: "is it nice?" }
`);
  const first = await runCounting(dir);
  assert.equal(caseOf(first.s, "q", "graded").result.skipped, undefined, "first run judges");
  assert.ok(first.calls >= 2, "subject + judge votes were called");
  const st = await store(dir);
  assert.ok(st.cases["q/graded"]?.fp, "judge fingerprint recorded");

  const { s, calls } = await runCounting(dir, { changedOnly: true });
  assert.ok(caseOf(s, "q", "graded").result.skipped, "unchanged judge case is skipped");
  assert.equal(calls, 0, "neither the subject nor the judge was called");
});

test("fingerprintIgnore: a volatile prompt region is skipped as unchanged while the model still gets the full prompt", async () => {
  // The system prompt embeds a per-run volatile line (a sampled review word).
  // Without fingerprintIgnore the fp moves every run and nothing is ever
  // skipped; with it, the case is stable AND the model still receives the real,
  // full prompt (SAY: word) — proven by the case passing.
  const cfg = (word) => `
providers:
  m: { kind: openai-compatible, baseUrl: "{{MOCK}}/v1", model: mock-1 }
layers:
  - name: b
    kind: llm
    provider: m
    fingerprintIgnore: ["DUE FOR REVIEW:.*"]
    cases:
      - name: greet
        system: "SAY: hello\\nDUE FOR REVIEW: ${word}"
        prompt: "hi"
        expect: { text: { $contains: hello } }
`;
  const dir = await scaffold(cfg("apple, banana"));
  await run(dir); // records fp with the review line blanked
  // the volatile line changes, nothing else does
  await writeFile(path.join(dir, "heyllm.yaml"), cfg("cherry, date").replaceAll("{{MOCK}}", mock.base));
  const { s, calls } = await runCounting(dir, { changedOnly: true });
  assert.ok(caseOf(s, "b", "greet").result.skipped, "the case is skipped despite the changed review words");
  assert.equal(calls, 0);

  // control: WITHOUT the ignore, the same volatile change forces a re-run
  const dir2 = await scaffold(cfg("apple, banana").replace(/    fingerprintIgnore:.*\n/, ""));
  await run(dir2);
  await writeFile(
    path.join(dir2, "heyllm.yaml"),
    cfg("cherry, date").replace(/    fingerprintIgnore:.*\n/, "").replaceAll("{{MOCK}}", mock.base)
  );
  const s2 = await run(dir2, { changedOnly: true });
  assert.ok(!caseOf(s2, "b", "greet").result.skipped, "without ignore, the volatile change re-runs");
});

test("fingerprintIgnore does NOT mask a change outside the ignored region", async () => {
  const cfg = (instruction, word) => `
providers:
  m: { kind: openai-compatible, baseUrl: "{{MOCK}}/v1", model: mock-1 }
layers:
  - name: b
    kind: llm
    provider: m
    fingerprintIgnore: ["DUE FOR REVIEW:.*"]
    cases:
      - name: greet
        system: "SAY: ${instruction}\\nDUE FOR REVIEW: ${word}"
        prompt: "hi"
        expect: { text: { $exists: true } }
`;
  const dir = await scaffold(cfg("hello", "apple"));
  await run(dir);
  // the INSTRUCTION changes (outside the ignored region) — must re-run
  await writeFile(path.join(dir, "heyllm.yaml"), cfg("goodbye", "apple").replaceAll("{{MOCK}}", mock.base));
  const s = await run(dir, { changedOnly: true });
  assert.ok(!caseOf(s, "b", "greet").result.skipped, "a real instruction change is still detected");
});

test("changing only the RUBRIC re-runs a judge case (judging differently is a different test)", async () => {
  const base = (q) => `
providers:
  m: { kind: openai-compatible, baseUrl: "{{MOCK}}/v1", model: mock-subject }
  j: { kind: openai-compatible, baseUrl: "{{MOCK}}/v1", model: mock-judge }
layers:
  - name: q
    kind: judge
    subject: m
    judge: j
    threshold: 5
    cases:
      - name: graded
        input: { system: "SAY: hello", prompt: "hi" }
        rubric:
          - { id: nice, question: "${q}" }
`;
  const dir = await scaffold(base("is it nice?"));
  await run(dir);
  assert.ok(caseOf(await run(dir, { changedOnly: true }), "q", "graded").result.skipped);
  // same subject, different question → must re-run
  await writeFile(path.join(dir, "heyllm.yaml"), base("is it EXCELLENT?").replaceAll("{{MOCK}}", mock.base));
  const s = await run(dir, { changedOnly: true });
  assert.ok(!caseOf(s, "q", "graded").result.skipped, "a rubric change re-runs the judge case");
});
