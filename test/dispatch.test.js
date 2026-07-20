/**
 * dispatch layer + `dispatch:` block — the chain past the model:
 * model response → your reducer → the state a user would actually see.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig, runSuite, loadLayerCases, validateCases } from "../dist/index.js";
import { startMockLLM } from "./mock-llm.js";

let mock;
test.before(async () => { mock = await startMockLLM(); });
test.after(async () => { await mock.close(); });

// A realistic reducer: a gate condition (hidden screen blocks the card) and an
// effect. This mirrors the shape of a real app's tool-call handler.
const REDUCER = `
export default function reduce(state, call) {
  if (call.name === "show_case_explanation") {
    if (state.screenState === "hidden") return state;              // gated
    const n = Number(call.args?.caseNumber);
    if (!Number.isInteger(n)) return state;
    return { state: { ...state, panel: { kind: "case", caseNumber: n } },
             effects: [{ type: "trackCaseView", caseNumber: n }] };
  }
  if (call.name === "set_screen_state")
    return { ...state, screenState: call.args?.visible ? "visible" : "hidden" };
  if (call.name === "close_screen_content") return { ...state, panel: null };
  return state;   // NOTE: no handler for show_case_table — silently dead
}
`;

const scaffold = async (files) => {
  const dir = await mkdtemp(path.join(tmpdir(), "heyllm-disp-"));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, content.replaceAll("{{MOCK}}", mock.base));
  }
  return dir;
};
const run = async (dir, opts = {}) => runSuite(await loadConfig(path.join(dir, "heyllm.yaml")), opts);
const caseOf = (s, l, n) => s.layers.find((x) => x.name === l)?.cases.find((c) => c.name === n);

test("dispatch layer replays recorded calls with no model at all", async () => {
  const dir = await scaffold({
    "reducer.mjs": REDUCER,
    "heyllm.yaml": `
providers: {}
layers:
  - name: chain
    kind: dispatch
    cases:
      - name: card-appears
        module: ./reducer.mjs
        initialState: { screenState: visible, panel: null }
        calls:
          - { name: show_case_explanation, args: { caseNumber: 29 } }
        expect:
          state: { panel: { kind: case, caseNumber: 29 } }
          effects: { $contains: [{ type: trackCaseView, caseNumber: 29 }] }

      - name: hidden-screen-blocks-card
        module: ./reducer.mjs
        initialState: { screenState: hidden, panel: null }
        calls:
          - { name: show_case_explanation, args: { caseNumber: 29 } }
        expect:
          state: { panel: null }
          effects: { $length: 0 }

      - name: state-changes-across-calls
        module: ./reducer.mjs
        initialState: { screenState: hidden, panel: null }
        calls:
          - { name: set_screen_state, args: { visible: true } }
          - { name: show_case_explanation, args: { caseNumber: 8 } }
          - { name: close_screen_content }
        expect:
          state: { screenState: visible, panel: null }
          effects: { $length: 1 }

      - name: catches-a-tool-with-no-handler
        module: ./reducer.mjs
        initialState: { screenState: visible, tableOpen: false }
        calls:
          - { name: show_case_table }
        expect:
          state: { tableOpen: true }   # reducer has no branch → stays false
`,
  });
  const s = await run(dir);
  assert.equal(caseOf(s, "chain", "card-appears").result.ok, true, JSON.stringify(caseOf(s, "chain", "card-appears").result.failures));
  assert.equal(caseOf(s, "chain", "hidden-screen-blocks-card").result.ok, true);
  assert.equal(caseOf(s, "chain", "state-changes-across-calls").result.ok, true);
  // the silently-dead tool is exactly what this layer exists to catch
  const dead = caseOf(s, "chain", "catches-a-tool-with-no-handler").result;
  assert.equal(dead.ok, false);
  assert.match(dead.failures[0].path, /state\.tableOpen/);
});

test("`dispatch:` block folds the LIVE model's tool calls through the reducer", async () => {
  const dir = await scaffold({
    "reducer.mjs": `
export default function reduce(state, call) {
  if (call.name === "get_weather")
    return { state: { ...state, lastCity: call.args?.city }, effects: [{ type: "fetched" }] };
  return state;
}
`,
    "fixtures/tools.json": JSON.stringify([
      { name: "get_weather", parameters: { type: "object", properties: { city: { type: "string" } } } },
    ]),
    "heyllm.yaml": `
providers:
  m: { kind: openai-compatible, baseUrl: "{{MOCK}}/v1", model: mock-1 }
layers:
  - name: b
    kind: llm
    provider: m
    gate: false
    cases:
      - name: model-to-ui-chain
        prompt: "what is the weather today?"
        tools: file:fixtures/tools.json
        toolResponses: { get_weather: { temp: 23 } }
        expect: { toolCalled: get_weather }
        dispatch:
          module: ./reducer.mjs
          initialState: { lastCity: null }
          expect:
            state: { lastCity: Seoul }
            effects: { $contains: [{ type: fetched }] }
`,
  });
  const s = await run(dir);
  const r = caseOf(s, "b", "model-to-ui-chain").result;
  assert.equal(r.ok, true, JSON.stringify(r.failures));
  assert.deepEqual(r.dispatchState, { lastCity: "Seoul" });
  assert.deepEqual(r.dispatchEffects, [{ type: "fetched" }]);
});

test("`dispatch:` block FAILS when the model is right but the app does nothing", async () => {
  const dir = await scaffold({
    // the app forgot to handle get_weather — the classic silent chain break
    "reducer.mjs": `export default function reduce(state) { return state; }`,
    "fixtures/tools.json": JSON.stringify([{ name: "get_weather", parameters: { type: "object", properties: {} } }]),
    "heyllm.yaml": `
providers:
  m: { kind: openai-compatible, baseUrl: "{{MOCK}}/v1", model: mock-1 }
layers:
  - name: b
    kind: llm
    provider: m
    gate: false
    cases:
      - name: broken-chain
        prompt: "what is the weather today?"
        tools: file:fixtures/tools.json
        toolResponses: { get_weather: { temp: 23 } }
        expect: { toolCalled: get_weather }      # model side: PASSES
        dispatch:
          module: ./reducer.mjs
          initialState: { lastCity: null }
          expect: { state: { lastCity: Seoul } }  # app side: FAILS
`,
  });
  const s = await run(dir);
  const r = caseOf(s, "b", "broken-chain").result;
  assert.equal(r.ok, false, "the model was right but the UI never changed — must fail");
  assert.match(r.failures[0].path, /dispatch\.state/);
});

test("dispatch reports a missing/invalid reducer module clearly", async () => {
  const dir = await scaffold({
    "heyllm.yaml": `
providers: {}
layers:
  - name: chain
    kind: dispatch
    gate: false
    cases:
      - { name: no-module, module: ./nope.mjs, calls: [{ name: x }], expect: { state: {} } }
`,
  });
  const s = await run(dir);
  const r = caseOf(s, "chain", "no-module").result;
  assert.equal(r.ok, false);
  assert.match(r.failures[0].message, /could not be imported/);
});

test("validate lints dispatch cases (module + calls required)", async () => {
  const dir = await scaffold({
    "heyllm.yaml": `
providers: {}
layers:
  - { name: chain, kind: dispatch, include: "cases/*.yaml" }
`,
    "cases/a.yaml": `kind: dispatch\ncases:\n  - name: incomplete\n    expect: { state: {} }\n`,
  });
  const config = await loadConfig(path.join(dir, "heyllm.yaml"));
  const problems = validateCases(config.layers[0], await loadLayerCases(config.layers[0], config.baseDir));
  assert.equal(problems.length, 2);
  assert.ok(problems.some((p) => /needs 'module'/.test(p)));
  assert.ok(problems.some((p) => /needs a non-empty 'calls'/.test(p)));
});
