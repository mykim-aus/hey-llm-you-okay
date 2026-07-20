/**
 * Layer integration through runSuite against the mock LLM — static, exec,
 * http (save-chaining), llm (tools/conversation/flaky), judge (votes/
 * threshold/weights/minScores), pyramid halt, tags/grep filters.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
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
  const dir = await mkdtemp(path.join(tmpdir(), "haechi-"));
  await writeFile(path.join(dir, "haechi.yaml"), configYaml.replaceAll("{{MOCK}}", mock.base));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, content.replaceAll("{{MOCK}}", mock.base));
  }
  return dir;
}

const run = async (dir, opts = {}) => runSuite(await loadConfig(path.join(dir, "haechi.yaml")), opts);

const caseOf = (summary, layerName, caseName) =>
  summary.layers.find((l) => l.name === layerName)?.cases.find((c) => c.name === caseName);

test("static: forbid catches pattern with file:line; require passes", async () => {
  const dir = await scaffold(
    `
providers: {}
layers:
  - name: s
    kind: static
    cases:
      - { name: clean, file: prompts/good.txt, forbid: ["BADWORD"], require: [{ pattern: "SAFETY" }] }
      - { name: dirty, file: prompts/bad.txt, forbid: ["BADWORD"] }
`,
    { "prompts/good.txt": "hello\nSAFETY first\n", "prompts/bad.txt": "line1\nhas BADWORD here\n" }
  );
  const s = await run(dir);
  assert.equal(caseOf(s, "s", "clean").result.ok, true);
  const dirty = caseOf(s, "s", "dirty").result;
  assert.equal(dirty.ok, false);
  assert.match(dirty.failures[0].path, /bad\.txt:2$/); // line number
});

test("exec: exit code + stdout assertion", async () => {
  const dir = await scaffold(`
providers: {}
layers:
  - name: e
    kind: exec
    cases:
      - { name: ok, command: "echo haechi-runs", expect: { stdout: "haechi-runs" } }
      - { name: fails, command: "exit 3" }
`);
  const s = await run(dir);
  assert.equal(caseOf(s, "e", "ok").result.ok, true);
  const f = caseOf(s, "e", "fails").result;
  assert.equal(f.ok, false);
  assert.match(f.failures[0].message, /expected 0, got 3/);
});

test("http: status/json asserts + save-chaining {{token}} across cases", async () => {
  const dir = await scaffold(`
providers: {}
layers:
  - name: api
    kind: http
    cases:
      - name: wrong-password
        request: { method: POST, url: "{{MOCK}}/api/login", json: { user: haechi, pass: wrong } }
        expect: { status: 401, json: { error: login_required } }
      - name: login
        request: { method: POST, url: "{{MOCK}}/api/login", json: { user: haechi, pass: beast } }
        expect: { status: 200, jsonPath: { token: { $pattern: "^tok-" } } }
        save: { token: json.token }
      - name: me-authorized
        request: { url: "{{MOCK}}/api/me", headers: { authorization: "Bearer {{token}}" } }
        expect: { status: 200, json: { email: haechi@example.com } }
`);
  const s = await run(dir);
  for (const name of ["wrong-password", "login", "me-authorized"])
    assert.equal(caseOf(s, "api", name).result.ok, true, name);
});

test("llm: tool loop with fixtures — toolCalled/toolArgs + grounded final text", async () => {
  const dir = await scaffold(
    `
providers:
  m: { kind: openai-compatible, baseUrl: "{{MOCK}}/v1", model: mock-1 }
layers:
  - name: b
    kind: llm
    provider: m
    cases:
      - name: weather-tool
        prompt: "오늘 서울 날씨 어때?"
        tools: file:fixtures/tools.json
        toolResponses:
          get_weather: { temp: 23, sky: "맑음" }
        expect:
          toolCalled: get_weather
          toolArgs: { get_weather: { city: 서울 } }
          text: { $contains: "맑음" }
      - name: no-tool-smalltalk
        prompt: "안녕!"
        tools: file:fixtures/tools.json
        expect: { notToolCalled: [get_weather], text: { $contains: "echo" } }
`,
    {
      "fixtures/tools.json": JSON.stringify([
        {
          name: "get_weather",
          description: "current weather",
          parameters: { type: "object", properties: { city: { type: "string" } } },
        },
      ]),
    }
  );
  const s = await run(dir);
  assert.equal(caseOf(s, "b", "weather-tool").result.ok, true, JSON.stringify(caseOf(s, "b", "weather-tool").result.failures));
  assert.equal(caseOf(s, "b", "no-tool-smalltalk").result.ok, true);
});

test("llm: conversation multi-turn with per-turn expect", async () => {
  const dir = await scaffold(`
providers:
  m: { kind: openai-compatible, baseUrl: "{{MOCK}}/v1", model: mock-1 }
layers:
  - name: b
    kind: llm
    provider: m
    cases:
      - name: flow
        conversation:
          - user: "커피 주문할게"
            expect: { text: { $contains: "커피" } }
          - user: "가장 큰 걸로"
        expect: { text: { $contains: "가장 큰 걸로" } }
`);
  const s = await run(dir);
  assert.equal(caseOf(s, "b", "flow").result.ok, true, JSON.stringify(caseOf(s, "b", "flow").result.failures));
});

test("llm: repeat + passRate absorbs a flaky first attempt", async () => {
  const dir = await scaffold(`
providers:
  m: { kind: openai-compatible, baseUrl: "{{MOCK}}/v1", model: mock-1 }
layers:
  - name: b
    kind: llm
    provider: m
    concurrency: 1
    cases:
      - name: flaky-tolerated
        prompt: "FLAKY-alpha please"
        repeat: 3
        passRate: 0.5
        expect: { text: { $contains: "MAGIC" } }
`);
  const s = await run(dir);
  const r = caseOf(s, "b", "flaky-tolerated").result;
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.detail.passed, 2); // 1st NOPE, then MAGIC ×2
});

test("judge: votes/threshold/weights/minScores through the mock judge", async () => {
  const dir = await scaffold(`
providers:
  m: { kind: openai-compatible, baseUrl: "{{MOCK}}/v1", model: mock-subject }
  j: { kind: openai-compatible, baseUrl: "{{MOCK}}/v1", model: mock-judge }
layers:
  - name: q
    kind: judge
    subject: m
    judge: j
    votes: 3
    cases:
      - name: good-output
        input: { system: "SAY: 좋은답변", prompt: "질문" }
        rubric:
          - { id: helpful, question: "도움이 되는가?", weight: 3 }
          - { id: safe, question: "안전한가?" }
        threshold: 7
      - name: bad-output-fails-threshold
        input: { system: "SAY: BADWORD", prompt: "질문" }
        rubric: [{ id: helpful, question: "도움이 되는가?" }]
        threshold: 7
      - name: weighted-mix
        input: { system: "SAY: 무난한답변", prompt: "질문" }
        rubric:
          - { id: helpful, question: "도움?", weight: 3 }      # mock: 9
          - { id: strict-format, question: "형식?", weight: 1 } # mock: 3 (id contains "strict")
        threshold: 7   # weighted = (9*3+3*1)/4 = 7.5 → pass
      - name: minscore-floor
        input: { system: "SAY: 무난한답변", prompt: "질문" }
        rubric:
          - { id: helpful, question: "도움?" }
          - { id: strict-format, question: "형식?" }
        minScores: { strict-format: 5 }   # mock scores 3 → fail
`);
  const s = await run(dir);
  const good = caseOf(s, "q", "good-output").result;
  assert.equal(good.ok, true, JSON.stringify(good.failures));
  assert.equal(good.score, 9);
  assert.equal(good.votes.length, 3);
  const bad = caseOf(s, "q", "bad-output-fails-threshold").result;
  assert.equal(bad.ok, false);
  assert.match(bad.failures[0].message, /below threshold/);
  assert.equal(caseOf(s, "q", "weighted-mix").result.ok, true);
  assert.equal(caseOf(s, "q", "weighted-mix").result.score, 7.5);
  const floor = caseOf(s, "q", "minscore-floor").result;
  assert.equal(floor.ok, false);
  assert.match(floor.failures[0].message, /mean 3 below 5/);
});

test("pyramid: gated failure halts later layers; --keep-going overrides; skip/tags/grep", async () => {
  const dir = await scaffold(`
providers:
  m: { kind: openai-compatible, baseUrl: "{{MOCK}}/v1", model: mock-1 }
layers:
  - name: gatefail
    kind: exec
    cases: [{ name: boom, command: "exit 1" }]
  - name: expensive
    kind: llm
    provider: m
    cases:
      - { name: never-runs, prompt: hi, expect: { text: echo } }
      - { name: tagged, tags: [security], prompt: hi, expect: { text: echo } }
      - { name: skipped-one, skip: true, prompt: hi }
`);
  const halted = await run(dir);
  assert.equal(halted.ok, false);
  assert.deepEqual(halted.halted, ["expensive"]);

  const kept = await run(dir, { keepGoing: true });
  assert.equal(kept.halted.length, 0);
  assert.equal(caseOf(kept, "expensive", "never-runs").result.ok, true);
  assert.equal(caseOf(kept, "expensive", "skipped-one").result.skipped, "skipped");

  const only = await run(dir, { only: ["expensive"], tags: ["security"] });
  assert.equal(only.layers.length, 1);
  assert.equal(only.layers[0].cases.length, 1);
  assert.equal(only.layers[0].cases[0].name, "tagged");
});

test("layer env guard: missing env fails gated layer, skips non-gated", async () => {
  const dir = await scaffold(`
providers: {}
layers:
  - { name: needs-env, kind: exec, env: [HAECHI_NO_SUCH_ENV_VAR], cases: [{ name: x, command: "true" }] }
`);
  const s = await run(dir);
  assert.equal(s.ok, false);
  assert.match(s.layers[0].skipped, /missing env/);
});

test("exec: ref — system prompt built by a command, memoized per process", async () => {
  const dir = await scaffold(
    `
providers:
  m: { kind: openai-compatible, baseUrl: "{{MOCK}}/v1", model: mock-1 }
layers:
  - name: b
    kind: llm
    provider: m
    cases:
      - name: exec-built-prompt
        system: "exec:node build-prompt.mjs"
        prompt: "say it"
        repeat: 2
        expect: { text: EXECMAGIC }
`,
    {
      // 호출될 때마다 부수효과 파일에 줄을 추가 — memoization이면 repeat×라운드에도 1줄
      "build-prompt.mjs": `
import { appendFileSync } from "node:fs";
appendFileSync("calls.log", "x\\n");
console.log("SAY: EXECMAGIC");
`,
    }
  );
  const s = await run(dir);
  const r = caseOf(s, "b", "exec-built-prompt").result;
  assert.equal(r.ok, true, JSON.stringify(r.failures));
  const { readFile } = await import("node:fs/promises");
  const calls = await readFile(path.join(dir, "calls.log"), "utf8");
  assert.equal(calls.trim().split("\n").length, 1); // memoized
});
