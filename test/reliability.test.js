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

// ── run axis: the failure a vote-spread gate is blind to ──────────────
// Measured for real: (9,8) then (2,3) then (10,9). Agreement WITHIN each run
// was perfect, so vote-spread called all three stable — and the middle run's
// tight agreement stamped confidence on a verdict 6 points off.

const RUNDRIFT_YAML = `${PROVIDERS}
settings: { maxDrop: 1 }
layers:
  - name: q
    kind: judge
    subject: m
    judge: j
    gate: false
    votes: 2
    reliability: { minRuns: 3 }
    cases:
      - name: drifting
        input: { system: "SAY: RUNDRIFT-marker", prompt: "질문" }
        rubric: [{ id: RUNDRIFT, question: "RUNDRIFT 판정?" }]
        threshold: 7
`;

test("run-axis: identical votes each run, level moving between runs → INCONCLUSIVE", async () => {
  const dir = await scaffold(RUNDRIFT_YAML);
  const levels = [9, 2, 10]; // the measured pattern
  const results = [];
  for (const level of levels) {
    mock.state.rundriftLevel = level;
    results.push((await run(dir)).layers[0].cases[0].result);
  }
  delete mock.state.rundriftLevel;

  // every run agreed with itself — the old gate saw nothing wrong
  for (const r of results) assert.equal(r.agreement.spread, 0, "votes agree within each run");
  assert.equal(results[0].inconclusive, undefined, "run 1: no history yet");
  assert.equal(results[1].inconclusive, undefined, "run 2: below minRuns");

  // by run 3 the ledger has enough history to see the 8-point swing
  const last = results[2];
  assert.ok(last.inconclusive, `expected INCONCLUSIVE, got ${JSON.stringify(last.inconclusive)}`);
  assert.match(last.inconclusive, /across 3 runs/);
  assert.match(last.inconclusive, /spread 8/);
  assert.equal(last.agreement.runAxis.spread, 8);
  assert.equal(last.agreement.runAxis.runs, 3);
});

test("run-axis attribution: same output hash ⇒ the JUDGE moved, not the subject", async () => {
  const dir = await scaffold(RUNDRIFT_YAML);
  let last;
  for (const level of [9, 2, 10]) {
    mock.state.rundriftLevel = level;
    last = (await run(dir)).layers[0].cases[0].result;
  }
  delete mock.state.rundriftLevel;
  // the subject said "SAY: RUNDRIFT-marker" → identical text every run
  assert.equal(last.agreement.runAxis.attribution, "judge-only");
  assert.match(last.inconclusive, /byte-identical/);
  assert.match(last.inconclusive, /missing decision rule/);
});

test("ledger is written on FAILED runs too (no ratchet to the top of the distribution)", async () => {
  const dir = await scaffold(RUNDRIFT_YAML);
  mock.state.rundriftLevel = 2; // below threshold 7 → the case FAILS
  const r = (await run(dir)).layers[0].cases[0].result;
  delete mock.state.rundriftLevel;
  assert.equal(r.ok, false, "the run failed…");

  const { loadLedger } = await import("../dist/ledger.js");
  const ledger = await loadLedger(dir);
  const item = ledger.items["q/drifting#RUNDRIFT"];
  assert.ok(item, "…and was still recorded");
  assert.deepEqual(item.runs[0].scores, [2, 2]);
});

test("editing a rubric item resets its history, siblings keep theirs", async () => {
  const { itemFingerprint } = await import("../dist/ledger.js");
  const a = itemFingerprint({ question: "Q", ask: "scale", judgeModel: "m" });
  assert.equal(itemFingerprint({ question: "Q", ask: "scale", judgeModel: "m" }), a);
  assert.notEqual(itemFingerprint({ question: "Q2", ask: "scale", judgeModel: "m" }), a, "question change");
  assert.notEqual(itemFingerprint({ question: "Q", rules: ["r"], ask: "scale", judgeModel: "m" }), a, "rules change");
  assert.notEqual(itemFingerprint({ question: "Q", ask: "binary", judgeModel: "m" }), a, "ask change");
  assert.notEqual(itemFingerprint({ question: "Q", ask: "scale", judgeModel: "other" }), a, "judge model change");
});

test("`rules:` are rendered into the judge prompt without breaking rubric parsing", async () => {
  const { buildJudgePrompt } = await import("../dist/layers/judge.js");
  const p = buildJudgePrompt({
    context: "c",
    output: "o",
    scale: { min: 1, max: 10 },
    rubric: [
      { id: "x", question: "Q?", weight: 1, ask: "binary", rules: ["a token used to explain a pattern is NOT a violation"] },
    ],
  });
  assert.match(p, /- \[x\] \(yes\/no\) Q\?/);
  assert.match(p, /\n {4}· a token used to explain/, "indented, never at '- [' which id-scrapers key on");
  // reasoning/spans must precede scores so the judge cannot rationalise a number
  assert.ok(p.indexOf('"reasoning"') < p.indexOf('"scores"'), "scores must come last");
});
