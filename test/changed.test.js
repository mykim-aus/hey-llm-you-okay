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

test("--changed-only replays the cached result of an unchanged case WITHOUT calling the model", async () => {
  const dir = await scaffold(CFG());
  await run(dir); // populate the fingerprint AND cache the passing output
  const { s, calls } = await runCounting(dir, { changedOnly: true });
  const r = caseOf(s, "b", "greet").result;
  assert.equal(calls, 0, "no paid call was made for the unchanged case");
  // The verdict now comes from REPLAYING the cached output, not a skip: a real
  // ✓/✗ at zero cost, clearly marked as cached so it is not read as a live pass.
  assert.ok(r.cached, "the verdict is labelled as a cached replay");
  assert.match(r.cached, /input unchanged/);
  assert.equal(r.skipped, undefined, "cache-replay supersedes the bare skip");
  assert.equal(r.ok, true, "the cached output still satisfies the assertions");
});

test("--changed-only falls back to skip when the store has a fp but no cached output (pre-cache store)", async () => {
  // Backward compatibility: a prompt store written before output caching existed
  // has {fp, at} and no `output`. Such an unchanged case must SKIP (the old
  // behaviour), never crash and never fabricate a cached verdict from nothing.
  const dir = await scaffold(CFG());
  await run(dir); // records fp + output
  // strip the cached output to simulate an old store entry
  const st = await store(dir);
  delete st.cases["b/greet"].output;
  await writeFile(path.join(dir, ".heyllm/prompts.json"), JSON.stringify(st, null, 2));

  const { s, calls } = await runCounting(dir, { changedOnly: true });
  const r = caseOf(s, "b", "greet").result;
  assert.equal(calls, 0, "still no paid call");
  assert.ok(r.skipped, "no cached output → skip, exactly as before caching existed");
  assert.equal(r.cached, undefined);
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
  // A re-run against an EXISTING baseline says WHY it ran — a non-deterministic
  // payload that re-runs every time is otherwise a silent token drain.
  assert.match(r.changedNote || "", /payload changed since/, "the re-run reason is surfaced");
  assert.match(r.changedNote || "", /fingerprintIgnore/, "and it points at the fix");
});

test("--changed-only: a case with NO baseline yet gets no changedNote (nothing to warn about)", async () => {
  const dir = await scaffold(CFG());
  // first ever run under --changed-only: no store → runs, but it is a first run,
  // not a re-run, so there is nothing to flag.
  const { s } = await runCounting(dir, { changedOnly: true });
  const r = caseOf(s, "b", "greet").result;
  assert.ok(!r.skipped);
  assert.equal(r.changedNote, undefined, "a first run is not a suspicious re-run");
});

test("a changed TOOL declaration re-runs — the case a file-diff of prompts would miss", async () => {
  const dir = await scaffold(CFG("        tools: file:tools.json"), {
    "tools.json": JSON.stringify([
      { name: "get_x", description: "old description", parameters: { type: "object", properties: {} } },
    ]),
  });
  await run(dir); // record fp incl. tool declarations
  const s1 = await runCounting(dir, { changedOnly: true });
  assert.ok(caseOf(s1.s, "b", "greet").result.cached, "unchanged tools → cached replay, no call");
  assert.equal(s1.calls, 0);

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
  assert.ok(caseOf(s, "b", "greet").result.cached, "unchanged (ignored region) → cached replay, no call, despite the changed review words");
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

test("fingerprintIgnore is multiline — a `^line$` pattern strips a line in the MIDDLE", async () => {
  // Regression: applyIgnore used `g` not `gm`, so `^TS: .*$` anchored to the
  // whole string and never matched a middle line — the ignore silently did
  // nothing and --changed-only/triage kept seeing the payload as "changed".
  const { fingerprintLlm, normalizeIgnore } = await import("../dist/changed.js");
  const ig = normalizeIgnore(["^TS: .*$"]);
  const a = { mode: "prompt", system: "SAY: X\nTS: 1\nEND", prompt: "go", params: {}, providerName: "m" };
  const b = { mode: "prompt", system: "SAY: X\nTS: 2\nEND", prompt: "go", params: {}, providerName: "m" };
  assert.equal(
    fingerprintLlm(a, undefined, ig),
    fingerprintLlm(b, undefined, ig),
    "only the ignored middle line differs, so the fingerprints must match"
  );
  // sanity: a change OUTSIDE the ignored line still moves the fingerprint
  const c = { ...b, system: "SAY: Y\nTS: 2\nEND" };
  assert.notEqual(fingerprintLlm(a, undefined, ig), fingerprintLlm(c, undefined, ig));
});

test("cache stores a PASSING attempt's output, not the last (passRate < 1 regression)", async () => {
  // Real bug from smoveth: repeat:2 + passRate:0.5, attempt 1 passes and attempt
  // 2 fails. The CASE passes (1/2 ≥ 0.5). Caching the LAST attempt would store
  // the failing output, and the --changed-only replay would then disagree with
  // the live verdict (✗ where live was ✓).
  const dir = await scaffold(`
providers:
  m: { kind: openai-compatible, baseUrl: "{{MOCK}}/v1", model: mock-1 }
layers:
  - name: b
    kind: llm
    provider: m
    repeat: 2
    passRate: 0.5
    cases:
      - name: pf
        system: "SAY: ignored"
        prompt: "PASSFIRST please"
        expect: { text: { $contains: MAGIC } }
`);
  const live = await run(dir);
  assert.equal(caseOf(live, "b", "pf").result.ok, true, "live: passes 1/2 under passRate 0.5");

  // replay from cache must AGREE with live — i.e. it cached the passing attempt
  const { s, calls } = await runCounting(dir, { changedOnly: true });
  const r = caseOf(s, "b", "pf").result;
  assert.equal(calls, 0, "replayed, no model call");
  assert.ok(r.cached, "cached replay");
  assert.equal(r.ok, true, "the cached (passing) output still satisfies the assertion — verdict matches live");
});

test("maxCacheAgeDays: a FRESH cache replays, an EXPIRED cache re-runs the model (drift re-check)", async () => {
  // Fresh: cache written now, 30-day limit → replay, no call.
  const fresh = await scaffold(`
providers:
  m: { kind: openai-compatible, baseUrl: "{{MOCK}}/v1", model: mock-1 }
settings:
  changedOnly: { maxCacheAgeDays: 30 }
layers:
  - name: b
    kind: llm
    provider: m
    cases:
      - { name: greet, system: "SAY: hello", prompt: "hi", expect: { text: { $contains: hello } } }
`);
  await run(fresh);
  const f = await runCounting(fresh, { changedOnly: true });
  assert.equal(f.calls, 0, "a fresh cache replays without a model call");
  assert.ok(caseOf(f.s, "b", "greet").result.cached);

  // Expired: backdate the stored `at` to 40 days ago against a 7-day limit → re-run.
  const exp = await scaffold(`
providers:
  m: { kind: openai-compatible, baseUrl: "{{MOCK}}/v1", model: mock-1 }
settings:
  changedOnly: { maxCacheAgeDays: 7 }
layers:
  - name: b
    kind: llm
    provider: m
    cases:
      - { name: greet, system: "SAY: hello", prompt: "hi", expect: { text: { $contains: hello } } }
`);
  await run(exp);
  const st = await store(exp);
  st.cases["b/greet"].at = new Date(Date.now() - 40 * 86400000).toISOString();
  await writeFile(path.join(exp, ".heyllm/prompts.json"), JSON.stringify(st, null, 2));
  const e = await runCounting(exp, { changedOnly: true });
  const r = caseOf(e.s, "b", "greet").result;
  assert.equal(e.calls, 1, "an expired cache re-runs the real model to catch provider drift");
  assert.ok(!r.cached && !r.skipped, "expired → a fresh live verdict, not a replay or skip");
  assert.match(r.changedNote || "", /cache older than 7d/, "and it says why it re-ran");
});

test("maxCacheAgeDays: a positive number is required (config error otherwise)", async () => {
  const dir = await scaffold(`
providers:
  m: { kind: openai-compatible, baseUrl: "{{MOCK}}/v1", model: mock-1 }
settings:
  changedOnly: { maxCacheAgeDays: -3 }
layers:
  - { name: b, kind: llm, provider: m, cases: [{ name: g, prompt: hi, expect: { text: "" } }] }
`);
  await assert.rejects(() => loadConfig(path.join(dir, "heyllm.yaml")), /positive number of days/);
});

test("cache-replay re-checks a changed `expect:` for free (expect is not in the fingerprint)", async () => {
  const dir = await scaffold(CFG()); // system "SAY: hello", model echoes "hello", expect contains hello
  await run(dir); // cache the "hello" output
  // tighten the assertion ONLY (prompt unchanged → fingerprint unchanged)
  await writeFile(
    path.join(dir, "heyllm.yaml"),
    CFG().replace("$contains: hello", "$contains: GOODBYE").replaceAll("{{MOCK}}", mock.base)
  );
  const { s, calls } = await runCounting(dir, { changedOnly: true });
  const r = caseOf(s, "b", "greet").result;
  assert.equal(calls, 0, "no model call — the payload did not change");
  assert.ok(r.cached, "replayed from cache");
  assert.equal(r.ok, false, "the NEW expect is evaluated against the cached output — and fails, for free");
});

test("cacheOutputs:false — fingerprints only: no user data on disk, skip instead of replay", async () => {
  // The cached output IS the user data the prompt carried (the model's verbatim
  // reply about this learner). Privacy-sensitive projects set cacheOutputs:false
  // and trade the cached-replay verdict for a plain unchanged-skip.
  const dir = await scaffold(`
providers:
  m: { kind: openai-compatible, baseUrl: "{{MOCK}}/v1", model: mock-1 }
settings:
  changedOnly: { cacheOutputs: false }
layers:
  - name: b
    kind: llm
    provider: m
    cases:
      - name: greet
        system: "SAY: hello"
        prompt: "hi"
        expect: { text: { $contains: hello } }
`);
  await run(dir); // populate
  const st = await store(dir);
  assert.ok(st.cases["b/greet"]?.fp, "fingerprint recorded");
  assert.equal(st.cases["b/greet"].output, undefined, "no output persisted");

  const { s, calls } = await runCounting(dir, { changedOnly: true });
  const r = caseOf(s, "b", "greet").result;
  assert.equal(calls, 0, "no model call");
  assert.ok(r.skipped, "skip, not a cached replay");
  assert.ok(!r.cached, "replay is impossible without a stored output");
});

test("cacheOutputs:false retroactively scrubs outputs cached before the setting existed", async () => {
  const cfg = (extra) => `
providers:
  m: { kind: openai-compatible, baseUrl: "{{MOCK}}/v1", model: mock-1 }
${extra}layers:
  - name: b
    kind: llm
    provider: m
    cases:
      - name: greet
        system: "SAY: hello"
        prompt: "hi"
        expect: { text: { $contains: hello } }
`;
  const dir = await scaffold(cfg(""));
  await run(dir); // caches WITH output (default)
  assert.ok((await store(dir)).cases["b/greet"].output, "output cached under the default");

  // the project later declares cacheOutputs:false — the next run must scrub
  await writeFile(
    path.join(dir, "heyllm.yaml"),
    cfg("settings:\n  changedOnly: { cacheOutputs: false }\n").replaceAll("{{MOCK}}", mock.base)
  );
  await run(dir, { changedOnly: true }); // skip run, but the scrub must still persist
  assert.equal(
    (await store(dir)).cases["b/greet"].output,
    undefined,
    "previously cached user data is removed from disk, not grandfathered"
  );
});
