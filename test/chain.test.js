/**
 * chain layer — full-chain run + counterfactual hop attribution.
 *
 * Every case here pins the same promise: when a multi-stage chain's FINAL
 * assertion fails, forcing a stage to its `golden` and re-running downstream
 * for real identifies WHICH stage decided wrong — not the stage that merely
 * surfaced the symptom. Stages are deterministic echo-scripts so the attributor
 * itself is tested without model noise.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig, runSuite } from "../dist/index.js";

async function project(files) {
  const dir = await mkdtemp(path.join(tmpdir(), "heyllm-chain-"));
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(dir, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, body);
    if (rel.endsWith(".mjs")) await chmod(full, 0o755);
  }
  return dir;
}
const run = async (dir) => runSuite(await loadConfig(path.join(dir, "heyllm.yaml")));
const only = (s) => s.layers[0].cases[0].result;

// A stage that reads JSON on stdin and writes JSON on stdout. `logic` is a JS
// body over `input` returning the output.
const stage = (logic) =>
  `import { readFileSync } from "node:fs";
const input = JSON.parse(readFileSync(0, "utf8") || "null");
const out = (${logic})(input);
process.stdout.write(JSON.stringify(out));
`;

test("chain passes when every stage is correct", async () => {
  const dir = await project({
    // model: emits {caseNumber} · resolve: caseNumber→case · reduce: →panel
    "model.mjs": stage(`() => ({ caseNumber: 8 })`),
    "resolve.mjs": stage(`(i) => ({ case: i.caseNumber })`),
    "reduce.mjs": stage(`(i) => ({ panel: i.case })`),
    "heyllm.yaml": `
layers:
  - name: grounding
    kind: chain
    cases:
      - name: modal-to-8
        input: "would vs will"
        stages:
          - { name: model,   run: "exec:node model.mjs",   golden: { caseNumber: 8 } }
          - { name: resolve, run: "exec:node resolve.mjs", golden: { case: 8 } }
          - { name: reduce,  run: "exec:node reduce.mjs" }
        expect: { json: { panel: 8 } }
`,
  });
  const r = only(await run(dir));
  assert.equal(r.ok, true, JSON.stringify(r.failures));
});

test("attributes to the MODEL stage when it decides wrong (symptom is downstream)", async () => {
  // The model emits a vague sentence; resolve grounds the sentence to the wrong
  // case by similarity; the panel shows the wrong case. The reduce stage did its
  // job — the DECISION was wrong at the model. Forcing model=golden recovers.
  const dir = await project({
    "model.mjs": stage(`() => ({ sentence: "What would you like?" })`),
    "resolve.mjs": stage(`(i) => ({ case: i.caseNumber ?? (i.sentence ? 43 : null) })`), // RAG mis-grounds the sentence
    "reduce.mjs": stage(`(i) => ({ panel: i.case })`),
    "heyllm.yaml": `
layers:
  - name: grounding
    kind: chain
    cases:
      - name: modal-to-8
        input: "would vs will"
        stages:
          - { name: model,   run: "exec:node model.mjs",   golden: { caseNumber: 8 } }
          - { name: resolve, run: "exec:node resolve.mjs", golden: { case: 8 } }
          - { name: reduce,  run: "exec:node reduce.mjs" }
        expect: { json: { panel: 8 } }
`,
  });
  const r = only(await run(dir));
  assert.equal(r.ok, false);
  // symptom: panel=43. attribution must name MODEL as culprit, not resolve/reduce.
  assert.match(r.outputTail, /CULPRIT = stage 'model'/);
  assert.match(r.outputTail, /force model=golden → downstream real → RECOVERS/);
});

test("attributes to the RESOLVE stage when the model was right but resolve is broken", async () => {
  // The model emits the CORRECT caseNumber:8, but resolve has a bug mapping 8→13.
  // Forcing model=golden does NOT recover (resolve still breaks); forcing
  // resolve=golden does. Culprit must be resolve, not model.
  const dir = await project({
    "model.mjs": stage(`() => ({ caseNumber: 8 })`),
    "resolve.mjs": stage(`(i) => ({ case: i.caseNumber === 8 ? 13 : i.caseNumber })`), // the bug
    "reduce.mjs": stage(`(i) => ({ panel: i.case })`),
    "heyllm.yaml": `
layers:
  - name: grounding
    kind: chain
    cases:
      - name: modal-to-8
        input: "would vs will"
        stages:
          - { name: model,   run: "exec:node model.mjs",   golden: { caseNumber: 8 } }
          - { name: resolve, run: "exec:node resolve.mjs", golden: { case: 8 } }
          - { name: reduce,  run: "exec:node reduce.mjs" }
        expect: { json: { panel: 8 } }
`,
  });
  const r = only(await run(dir));
  assert.equal(r.ok, false);
  assert.match(r.outputTail, /CULPRIT = stage 'resolve'/);
  // and it must have TRIED model first and seen it NOT recover
  assert.match(r.outputTail, /force model=golden → downstream real → still fails/);
});

test("a stage that emits exit 97 is INFRA (could not measure), not a failing test", async () => {
  const dir = await project({
    "model.mjs": `process.stderr.write("HTTP 429"); process.exit(97);`,
    "heyllm.yaml": `
layers:
  - name: grounding
    kind: chain
    cases:
      - name: modal-to-8
        input: "x"
        stages:
          - { name: model, run: "exec:node model.mjs" }
        expect: { json: { panel: 8 } }
`,
  });
  const summary = await run(dir);
  assert.equal(summary.ok, false);
  assert.ok(summary.infra?.length, "exit 97 in a stage must surface as infrastructure");
});
