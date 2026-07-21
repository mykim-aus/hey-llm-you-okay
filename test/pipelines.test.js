/**
 * Pipeline dashboard renderer — what pipelines exist, how they flow, last-run
 * results at a glance. Pure function, so tested directly with a synthetic run.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { renderPipelines } from "../dist/index.js";

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
