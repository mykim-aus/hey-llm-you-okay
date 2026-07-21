/**
 * The Automated Triage Protocol, end to end against the mock LLM:
 *
 *   1. green run with --update-baseline → snapshots stored
 *   2a. prompt edited to a failing one   → triage says YOUR-CHANGE
 *   2b. inputs unchanged + drift mode ON → triage says MODEL-DRIFT (B arm skipped)
 *   2c. flaky first attempt              → triage says FLAKY (isolated re-run passes)
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

const CONFIG = (repeat = 3) => `
providers:
  m: { kind: openai-compatible, baseUrl: "{{MOCK}}/v1", model: mock-1 }
settings:
  triage: { repeat: ${repeat} }
layers:
  - name: b
    kind: llm
    provider: m
    gate: false
    include: tests/*.yaml
`;

async function scaffold(promptWord, { repeat = 3 } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "heyllm-triage-"));
  await writeFile(path.join(dir, "heyllm.yaml"), CONFIG(repeat).replaceAll("{{MOCK}}", mock.base));
  await mkdir(path.join(dir, "tests"), { recursive: true });
  await mkdir(path.join(dir, "prompts"), { recursive: true });
  await writeFile(path.join(dir, "prompts/sys.txt"), `SAY: ${promptWord}\n`);
  await writeFile(
    path.join(dir, "tests/cases.yaml"),
    `cases:
  - name: says-magic
    system: file:../prompts/sys.txt
    prompt: "say the word"
    expect: { text: { $contains: "MAGIC" } }
`
  );
  return dir;
}

const run = async (dir, opts = {}) => runSuite(await loadConfig(path.join(dir, "heyllm.yaml")), opts);

test("triage verdict: YOUR-CHANGE — old prompt passes, new prompt fails", async () => {
  const dir = await scaffold("MAGIC");
  const green = await run(dir, { updateBaseline: true });
  assert.equal(green.layers[0].ok, true, "baseline run must be green");
  const baseline = JSON.parse(await readFile(path.join(dir, ".heyllm/baseline.json"), "utf8"));
  assert.ok(baseline.snapshots["b/says-magic"], "snapshot recorded");

  // the "developer" breaks the prompt
  await writeFile(path.join(dir, "prompts/sys.txt"), "SAY: WRONGWORD\n");
  const red = await run(dir, { triage: true });
  assert.equal(red.layers[0].ok, false);
  const t = red.triage.find((t) => t.caseName === "says-magic");
  assert.equal(t.verdict, "your-change", JSON.stringify(t));
  const snapArm = t.arms.find((a) => a.label === "snapshot");
  assert.equal(snapArm.passed, 3); // old prompt still works under today's model
});

test("triage verdict: MODEL-DRIFT — inputs identical to snapshot, provider drifted (B arm skipped)", async () => {
  const dir = await scaffold("MAGIC");
  await run(dir, { updateBaseline: true });

  await mock.setDrift(true); // provider silently updates the model over the weekend
  try {
    const red = await run(dir, { triage: true });
    assert.equal(red.layers[0].ok, false);
    const t = red.triage.find((t) => t.caseName === "says-magic");
    assert.equal(t.verdict, "model-drift", JSON.stringify(t));
    assert.match(t.reason, /byte-identical/);
    assert.equal(t.arms.length, 1); // diff shortcut: no tokens burned on the B arm
    // n=3, 3/3 unanimous fail → medium, and it must SAY so (never present an
    // n=3 attribution with the authority of a clean call).
    assert.equal(t.confidence, "medium", JSON.stringify(t));
    assert.match(t.reason, /confidence: medium/);
  } finally {
    await mock.setDrift(false);
  }
});

test("triage confidence: a byte-identical drift at repeat:5 is high, at repeat:1 is low", async () => {
  const dir = await scaffold("MAGIC", { repeat: 5 });
  await run(dir, { updateBaseline: true });
  await mock.setDrift(true);
  try {
    const red = await run(dir, { triage: true });
    const t = red.triage.find((t) => t.caseName === "says-magic");
    assert.equal(t.verdict, "model-drift");
    assert.equal(t.confidence, "high", "5/5 unanimous fail is high confidence");
    assert.doesNotMatch(t.reason, /raise settings.triage.repeat/, "high confidence needs no nudge");
  } finally {
    await mock.setDrift(false);
  }

  const dir1 = await scaffold("MAGIC", { repeat: 1 });
  await run(dir1, { updateBaseline: true });
  await mock.setDrift(true);
  try {
    const red = await run(dir1, { triage: true });
    const t = red.triage.find((t) => t.caseName === "says-magic");
    assert.equal(t.verdict, "model-drift");
    assert.equal(t.confidence, "low", "a single sample cannot support a confident attribution");
    assert.match(t.reason, /raise settings.triage.repeat/, "low confidence must ask for more samples");
  } finally {
    await mock.setDrift(false);
  }
});

test("triage verdict: FLAKY — isolated re-run passes", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "heyllm-triage-"));
  await writeFile(path.join(dir, "heyllm.yaml"), CONFIG().replaceAll("{{MOCK}}", mock.base));
  await mkdir(path.join(dir, "tests"), { recursive: true });
  await writeFile(
    path.join(dir, "tests/cases.yaml"),
    `cases:
  - name: flaky-case
    prompt: "FLAKY-triage-unique-xyz"
    expect: { text: { $contains: "MAGIC" } }
`
  );
  const red = await run(dir, { triage: true }); // 1st mock call fails → case fails
  assert.equal(red.layers[0].ok, false);
  const t = red.triage.find((t) => t.caseName === "flaky-case");
  assert.equal(t.verdict, "flaky", JSON.stringify(t));
  assert.equal(t.arms.length, 1); // early exit before the snapshot arm
});

test("triage verdict: NO-SNAPSHOT when nothing green was ever recorded (non-git dir)", async () => {
  const dir = await scaffold("WRONGWORD"); // fails from day one, no baseline
  const red = await run(dir, { triage: true });
  const t = red.triage.find((t) => t.caseName === "says-magic");
  assert.equal(t.verdict, "no-snapshot", JSON.stringify(t));
});

test("judge-layer baseline: score regression flags the case", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "heyllm-reg-"));
  await writeFile(
    path.join(dir, "heyllm.yaml"),
    `
providers:
  m: { kind: openai-compatible, baseUrl: "{{MOCK}}/v1", model: mock-1 }
  j: { kind: openai-compatible, baseUrl: "{{MOCK}}/v1", model: mock-1 }
settings: { maxDrop: 1 }
layers:
  - name: q
    kind: judge
    subject: m
    judge: j
    gate: false
    env: [HEYLLM_TEST_WORD]   # declared → interpolatable (no blanket env fallback)
    cases:
      - name: quality
        input: { system: "SAY: {{HEYLLM_TEST_WORD}}", prompt: "question" }
        rubric: [{ id: helpful, question: "helpful?" }]
`.replaceAll("{{MOCK}}", mock.base)
  );
  process.env.HEYLLM_TEST_WORD = "GOOD-ANSWER"; // mock judge scores 9
  const green = await run(dir, { updateBaseline: true });
  assert.equal(green.layers[0].cases[0].result.score, 9);

  process.env.HEYLLM_TEST_WORD = "BADWORD"; // mock judge scores 3 → drop 6 > maxDrop 1
  const red = await run(dir);
  delete process.env.HEYLLM_TEST_WORD;
  const r = red.layers[0].cases[0].result;
  assert.equal(r.ok, false);
  assert.ok(r.failures.some((f) => f.path === "baseline"), JSON.stringify(r.failures));
});
