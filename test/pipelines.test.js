/**
 * Pipeline dashboard renderer — what pipelines exist, how they flow, last-run
 * results at a glance. Pure function, so tested directly with a synthetic run.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { renderPipelines, pipelinesJson, flakyFromHistory } from "../dist/index.js";

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const stages = [
  { name: "hygiene", kind: "static", gate: true, count: 4, tags: [] },
  { name: "behavior", kind: "llm", gate: false, count: 11, tags: ["ui", "study"] },
  { name: "quality", kind: "judge", gate: false, count: 3, tags: [] },
];

const summary = {
  ok: false,
  startedAt: "2020-01-01T00:00:00Z",
  durationMs: 1300,
  profile: null,
  halted: ["quality"],
  layers: [
    { name: "hygiene", kind: "static", gate: true, ok: true, durationMs: 40, cases: [{ name: "a", result: { ok: true } }, { name: "b", result: { ok: true } }, { name: "c", result: { ok: true } }, { name: "d", result: { ok: true } }] },
    { name: "behavior", kind: "llm", gate: false, ok: false, durationMs: 44000, cases: [
      { name: "p", result: { ok: true } },
      { name: "f", result: { ok: false, failures: [{ message: "x" }] } },
      { name: "cch", result: { ok: true, cached: "replayed" } },
      { name: "sk", result: { ok: true, skipped: "unchanged" } },
    ] },
    // quality did not run — it was halted by the (non-gated here, but) upstream stop
  ],
};

test("dashboard shows the flow, the last-run banner, and per-stage results", () => {
  const text = strip(renderPipelines(stages, summary, { ageMs: 65_000 }).join("\n"));
  assert.match(text, /3 pipelines/);
  assert.match(text, /gated pyramid/);
  assert.match(text, /last run\s+FAIL/);
  assert.match(text, /1m ago/);
  // hygiene: all 4 pass
  assert.match(text, /hygiene.*✓4/);
  // behavior: 2 pass (incl. the cached replay), 1 fail, 1 skipped, 1 cached
  assert.match(text, /behavior.*✓2.*✗1.*○1.*⋯1/);
  // quality: halted (in summary.halted, not in layers)
  assert.match(text, /quality.*⊘ halted/);
  // gate badge on hygiene, flow connectors between stages
  assert.match(text, /gate/);
  assert.match(text, /│/);
});

test("with no prior run, the dashboard says so and marks every stage not-run", () => {
  const text = strip(renderPipelines(stages, null).join("\n"));
  assert.match(text, /no run recorded yet/);
  assert.match(text, /hygiene.*— not run —/);
});

test("verbose lists each stage's tags", () => {
  const text = strip(renderPipelines(stages, summary, { verbose: true }).join("\n"));
  assert.match(text, /tags: ui, study/);
});

test("names the failed cases (triage at a glance)", () => {
  const text = strip(renderPipelines(stages, summary).join("\n"));
  assert.match(text, /↳ failed:\s*f/); // behavior's failing case 'f'
});

test("surfaces flaky cases and per-stage age", () => {
  const text = strip(
    renderPipelines(stages, summary, { ageMs: 1000, stageAgeMs: { behavior: 3 * 24 * 3600_000 }, flaky: { behavior: ["p"] } }).join("\n")
  );
  assert.match(text, /↳ flaky:\s*p \(flips across runs\)/);
  assert.match(text, /3d ago/); // behavior stage refreshed long before the others
});

test("shows per-stage and total token spend", () => {
  const withUsage = {
    ...summary,
    usage: { inputTokens: 800000, outputTokens: 16000, calls: 40, complete: true, unmetered: 0, unsplit: 0, totalTokens: 816000, buckets: [] },
    layers: summary.layers.map((l) =>
      l.name === "behavior" ? { ...l, usage: { inputTokens: 180000, outputTokens: 300, calls: 9, complete: true, unmetered: 0, unsplit: 0, totalTokens: 180300, buckets: [] } } : l
    ),
  };
  const text = strip(renderPipelines(stages, withUsage).join("\n"));
  assert.match(text, /~816.0k tok/); // banner total
  assert.match(text, /behavior[\s\S]*?~180.3k tok/); // per-stage
});

test("flakyFromHistory flags only cases that FLIPPED pass↔fail", () => {
  const history = {
    stages: {
      behavior: {
        steady: ["pass", "pass", "pass"],
        flips: ["pass", "fail", "pass"],
        allfail: ["fail", "fail"],
        onlyonce: ["fail"],
      },
    },
  };
  const flaky = flakyFromHistory(history, ["behavior", "missing"]);
  assert.deepEqual(flaky, { behavior: ["flips"] });
});

test("--json emits a machine-readable dashboard", () => {
  const j = pipelinesJson(stages, summary, { flaky: { behavior: ["p"] } });
  assert.equal(j.ok, false);
  const behavior = j.pipelines.find((p) => p.name === "behavior");
  assert.equal(behavior.lastRun.failed, 1);
  assert.deepEqual(behavior.lastRun.failedCases, ["f"]);
  assert.deepEqual(behavior.lastRun.flakyCases, ["p"]);
  const quality = j.pipelines.find((p) => p.name === "quality");
  assert.equal(quality.lastRun.halted, true);
});
