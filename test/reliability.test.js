/**
 * Judge trustworthiness. Measured on a real case: asking about a fuzzy surface
 * property scored 2,3,8,9,9,10 for the SAME rubric item — a threshold gate on
 * that is a coin flip. These tests pin the machinery that refuses to issue a
 * verdict it cannot stand behind.
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

const scaffold = async (yaml) => {
  const dir = await mkdtemp(path.join(tmpdir(), "heyllm-rel-"));
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "heyllm.yaml"), yaml.replaceAll("{{MOCK}}", mock.base));
  return dir;
};
const run = async (dir, opts = {}) => runSuite(await loadConfig(path.join(dir, "heyllm.yaml")), opts);

const PROVIDERS = `
providers:
  m: { kind: openai-compatible, baseUrl: "{{MOCK}}/v1", model: mock-1 }
  j: { kind: openai-compatible, baseUrl: "{{MOCK}}/v1", model: mock-1 }
`;

test("disagreeing judges produce INCONCLUSIVE, not a coin-flip pass", async () => {
  // mock scores this rubric 2 then 10 then 2 then 10 — spread 8 on a 1-10 scale
  const dir = await scaffold(`${PROVIDERS}
layers:
  - name: q
    kind: judge
    subject: m
    judge: j
    gate: false
    votes: 4
    cases:
      - name: unstable
        input: { system: "SAY: UNSTABLE-marker", prompt: "질문" }
        rubric: [{ id: UNSTABLE, question: "UNSTABLE 판정?" }]
        threshold: 7
`);
  const r = (await run(dir)).layers[0].cases[0].result;
  assert.ok(r.inconclusive, `expected INCONCLUSIVE, got ${JSON.stringify(r)}`);
  assert.match(r.inconclusive, /disagreed by 8/);
  assert.equal(r.agreement.spread, 8);
  assert.equal(r.agreement.worstItem, "UNSTABLE");
  // non-gated layer: reported loudly but does not fail the build
  assert.equal(r.ok, true);
});

test("a GATED layer fails closed on an untrustworthy verdict", async () => {
  const dir = await scaffold(`${PROVIDERS}
layers:
  - name: q
    kind: judge
    subject: m
    judge: j
    gate: true
    votes: 4
    cases:
      - name: unstable
        input: { system: "SAY: UNSTABLE-marker", prompt: "질문" }
        rubric: [{ id: UNSTABLE, question: "UNSTABLE 판정?" }]
        threshold: 7
`);
  const s = await run(dir);
  const r = s.layers[0].cases[0].result;
  assert.ok(r.inconclusive);
  assert.equal(r.ok, false, "you asked for a gate; we cannot certify it, so it fails");
  assert.equal(s.ok, false);
});

test("reliability.maxSpread is configurable and can be disabled", async () => {
  const mk = (rel) => `${PROVIDERS}
layers:
  - name: q
    kind: judge
    subject: m
    judge: j
    gate: false
    votes: 4
    reliability: ${rel}
    cases:
      - name: unstable
        input: { system: "SAY: UNSTABLE-marker", prompt: "질문" }
        rubric: [{ id: UNSTABLE, question: "UNSTABLE?" }]
`;
  const tolerant = (await run(await scaffold(mk("{ maxSpread: 9 }")))).layers[0].cases[0].result;
  assert.equal(tolerant.inconclusive, undefined, "spread 8 is under maxSpread 9");
  assert.equal(tolerant.agreement.spread, 8);

  const off = (await run(await scaffold(mk("{ enforce: false }")))).layers[0].cases[0].result;
  assert.equal(off.inconclusive, undefined, "enforce:false scores anyway");
  assert.equal(off.agreement.spread, 8, "…but still reports the spread");
});

test("agreement is reported even when the judges agree perfectly", async () => {
  const dir = await scaffold(`${PROVIDERS}
layers:
  - name: q
    kind: judge
    subject: m
    judge: j
    gate: false
    votes: 3
    cases:
      - name: stable
        input: { system: "SAY: 좋은답변", prompt: "질문" }
        rubric: [{ id: helpful, question: "도움?" }]
        threshold: 7
`);
  const r = (await run(dir)).layers[0].cases[0].result;
  assert.equal(r.ok, true);
  assert.equal(r.agreement.spread, 0);
  assert.equal(r.agreement.worstItem, null);
});

test("binary rubric maps to the scale ends and removes the grey zone", async () => {
  const mk = (word) => `${PROVIDERS}
layers:
  - name: q
    kind: judge
    subject: m
    judge: j
    gate: false
    votes: 2
    cases:
      - name: bin
        input: { system: "SAY: ${word}", prompt: "질문" }
        rubric: [{ id: clean, question: "위반이 없는가?", ask: binary }]
        threshold: 7
`;
  const good = (await run(await scaffold(mk("정상응답")))).layers[0].cases[0].result;
  assert.equal(good.ok, true);
  assert.equal(good.score, 10, "binary pass → scale.max");
  assert.equal(good.agreement.spread, 0, "binary cannot drift within the scale");

  const bad = (await run(await scaffold(mk("BADWORD")))).layers[0].cases[0].result;
  assert.equal(bad.ok, false);
  assert.equal(bad.score, 1, "binary fail → scale.min");
});

test("citeSpan: fabricated evidence is flagged, real evidence is kept", async () => {
  const mk = (word) => `${PROVIDERS}
layers:
  - name: q
    kind: judge
    subject: m
    judge: j
    gate: false
    votes: 1
    cases:
      - name: cited
        input: { system: "SAY: ${word}", prompt: "질문" }
        rubric: [{ id: clean, question: "위반이 없는가?", ask: binary, citeSpan: true }]
`;
  // mock quotes "BADWORD" — which really is in the output
  const real = (await run(await scaffold(mk("BADWORD")))).layers[0].cases[0].result;
  assert.equal(real.votes[0].spans.clean, "BADWORD");

  // mock quotes "NOT-IN-OUTPUT-AT-ALL" — a hallucinated citation
  const fake = (await run(await scaffold(mk("정상응답")))).layers[0].cases[0].result;
  assert.match(fake.votes[0].spans.clean, /^⚠ not found in output/);
});
