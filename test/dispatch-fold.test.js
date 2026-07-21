/**
 * `dispatch:` fold of the model's TEXT (not just tool calls) + fold cache-replay.
 *
 * The bug this closes: UI that derives from what the assistant SAID (a panel
 * scraped from its text, a "look at X on screen" claim) is invisible to a
 * tool-calls-only fold. `fold: [toolCalls, text]` feeds the text as an event so
 * the reducer computes the state the user actually saw.
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

// A reducer whose UI depends on TEXT: an example panel that must clear when the
// assistant moves on to a different pattern word (the Case 8 "stale example" bug).
const REDUCER = `
export default function reduce(state, call) {
  if (call.name === "show_example")
    return { ...state, panel: { kind: "examples", text: call.args?.text } };
  if (call.name === "say") {
    const t = String(call.args?.text || "");
    if (/should/i.test(t) && state.panel?.kind === "examples") return { ...state, panel: null }; // stale clear
    return { ...state, said: t };
  }
  return state;
}
`;

const scaffold = async (files) => {
  const dir = await mkdtemp(path.join(tmpdir(), "heyllm-fold-"));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, content.replaceAll("{{MOCK}}", mock.base));
  }
  return dir;
};
const run = async (dir, opts = {}) => runSuite(await loadConfig(path.join(dir, "heyllm.yaml")), opts);
const caseOf = (s, l, n) => s.layers.find((x) => x.name === l)?.cases.find((c) => c.name === n);

const yaml = (dispatchBlock) => `
providers:
  m: { kind: openai-compatible, baseUrl: "{{MOCK}}/v1", model: mock-1 }
layers:
  - name: ui
    kind: llm
    provider: m
    gate: false
    cases:
      - name: c
        system: "SAY: shouldleave"
        prompt: "go"
${dispatchBlock}
`;

test("fold: [text] feeds the model's text into the reducer (stale example clears)", async () => {
  const dir = await scaffold({
    "reducer.mjs": REDUCER,
    "heyllm.yaml": yaml(`        dispatch:
          module: ./reducer.mjs
          fold: [text]
          initialState: { panel: { kind: examples, text: "You must go" }, said: null }
          expect: { state: { panel: null } }`),
  });
  const r = caseOf(await run(dir), "ui", "c").result;
  assert.equal(r.ok, true, JSON.stringify(r.failures));
  assert.deepEqual(r.dispatchState, { panel: null, said: null });
});

test("without fold: [text], a text-only turn folds NOTHING (back-compat: tool calls only)", async () => {
  const dir = await scaffold({
    "reducer.mjs": REDUCER,
    "heyllm.yaml": yaml(`        dispatch:
          module: ./reducer.mjs
          initialState: { panel: { kind: examples }, said: null }
          expect: { state: { panel: null } }`),
  });
  const r = caseOf(await run(dir), "ui", "c").result;
  // no tools → no tool calls → default fold [toolCalls] produces zero events → hard fail
  assert.equal(r.ok, false, "text must NOT fold by default");
  assert.match(r.failures[0].message, /no tool calls/);
});

test("a fold (dispatch) case caches + replays the UI outcome at zero model cost under --changed-only", async () => {
  const dir = await scaffold({
    "reducer.mjs": REDUCER,
    "heyllm.yaml": yaml(`        dispatch:
          module: ./reducer.mjs
          fold: [text]
          initialState: { panel: { kind: examples, text: "You must go" }, said: null }
          expect: { state: { panel: null } }`),
  });
  const before1 = mock.state.requests.length;
  const r1 = caseOf(await run(dir, { changedOnly: true }), "ui", "c").result;
  const calls1 = mock.state.requests.length - before1;
  assert.equal(r1.ok, true, "first run live");
  assert.equal(calls1, 1, "first run makes one model call");

  const before2 = mock.state.requests.length;
  const r2 = caseOf(await run(dir, { changedOnly: true }), "ui", "c").result;
  const calls2 = mock.state.requests.length - before2;
  assert.equal(calls2, 0, "second run replays from cache — no model call");
  assert.ok(r2.cached, "labelled as a cached replay");
  assert.equal(r2.ok, true, "the replayed UI fold still verifies");
  assert.deepEqual(r2.dispatchState, { panel: null, said: null }, "fold re-derived from cached output");
});

// Multi-turn: UI state threads across turns. The bug this closes — a turn-2
// panel still shows the turn-1 example ("must") while the model moved on to
// "should". Each turn's expect.state is asserted against the THREADED state.
const CONV_REDUCER = `
export default function reduce(state, call) {
  if (call.name === "say") {
    const t = String(call.args?.text || "");
    if (/should/i.test(t) && state.panel?.kind === "examples") return { ...state, panel: null };
    if (/must/i.test(t)) return { ...state, panel: { kind: "examples", word: "must" } };
  }
  return state;
}
`;

test("multi-turn: UI state threads across turns; a stale example clears on turn 2", async () => {
  const dir = await scaffold({
    "reducer.mjs": CONV_REDUCER,
    "heyllm.yaml": `
providers:
  m: { kind: openai-compatible, baseUrl: "{{MOCK}}/v1", model: mock-1 }
layers:
  - name: ui
    kind: llm
    provider: m
    gate: false
    cases:
      - name: stale-example-clears
        dispatch:
          module: ./reducer.mjs
          fold: [text]
          initialState: { panel: null }
        conversation:
          - user: "must go"
            expect: { state: { panel: { kind: examples, word: must } } }
          - user: "should leave"
            expect: { state: { panel: null } }
`,
  });
  const r = caseOf(await run(dir), "ui", "stale-example-clears").result;
  assert.equal(r.ok, true, JSON.stringify(r.failures));
  assert.deepEqual(r.dispatchState, { panel: null }, "final threaded state after turn 2");
});

test("multi-turn: a wrong per-turn UI expectation FAILS with the turn index", async () => {
  const dir = await scaffold({
    "reducer.mjs": CONV_REDUCER,
    "heyllm.yaml": `
providers:
  m: { kind: openai-compatible, baseUrl: "{{MOCK}}/v1", model: mock-1 }
layers:
  - name: ui
    kind: llm
    provider: m
    gate: false
    cases:
      - name: wrong-turn2
        dispatch: { module: ./reducer.mjs, fold: [text], initialState: { panel: null } }
        conversation:
          - user: "must go"
            expect: { state: { panel: { kind: examples, word: must } } }
          - user: "should leave"
            expect: { state: { panel: { kind: examples } } }   # WRONG: it cleared
`,
  });
  const r = caseOf(await run(dir), "ui", "wrong-turn2").result;
  assert.equal(r.ok, false, "the stale example DID clear — a wrong turn-2 expectation must fail");
  assert.match(r.failures[0].path, /turn\[1\]\.dispatch\.state/);
});

test("params.responseSchema is sent to the provider as a structured-output contract", async () => {
  const dir = await scaffold({
    "heyllm.yaml": `
providers:
  m: { kind: openai-compatible, baseUrl: "{{MOCK}}/v1", model: mock-1 }
layers:
  - name: schema
    kind: llm
    provider: m
    gate: false
    cases:
      - name: c
        prompt: "reply as json"
        params:
          responseSchema: { type: object, properties: { type: { type: string } }, required: [type] }
        expect: { text: { $contains: "echo" } }
`,
  });
  await run(dir);
  const last = mock.state.requests.at(-1);
  assert.equal(last.response_format?.type, "json_schema", "the case's responseSchema became a json_schema response_format");
  assert.equal(last.response_format?.json_schema?.schema?.required?.[0], "type");
});
