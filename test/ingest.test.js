/**
 * Bulk corpus ingestion (F3).
 *
 * The single most important test here is the vacuous-pass regression: an
 * ingested row must NEVER become a green tick. Everything else — dedup,
 * idempotency, comment preservation — protects a reviewer's work; that one
 * protects the meaning of the word PASS.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import YAML from "yaml";
import { loadConfig, runSuite, ingestCases, parseRows, normalizeText, jaccard, loadLayerCases, validateCases } from "../dist/index.js";

const CONFIG = `
providers:
  judge: { kind: command, command: echo }
settings:
  capture: { file: tests/captured.yaml }
layers:
  - name: quality
    kind: judge
    subject: judge
    judge: judge
    include: tests/captured.yaml
`;

async function project(extra = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "heyllm-ingest-"));
  await writeFile(path.join(dir, "heyllm.yaml"), CONFIG);
  await mkdir(path.join(dir, "tests"), { recursive: true });
  for (const [rel, body] of Object.entries(extra)) {
    const p = path.join(dir, rel);
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, body);
  }
  return dir;
}
const rows = (n = 3) =>
  Array.from({ length: n }, (_, i) => ({
    id: String(4820 + i),
    comment: { body: `complaint number ${i}: it keeps going off topic about refunds` },
    fields: { expected: `should quote the ${i} day window` },
  }));
const MAP = { input: "comment.body", expected: "fields.expected", id: "id" };

// ── parsing ──────────────────────────────────────────────────────────────────
test("parseRows: JSONL, JSON array sniff, and a line-numbered error", () => {
  assert.equal(parseRows('{"a":1}\n{"a":2}\n').length, 2);
  assert.equal(parseRows('  [{"a":1},{"a":2}]').length, 2, "leading [ is parsed as an array");
  assert.throws(() => parseRows('{"a":1}\nNOT JSON\n'), /line 2/);
});

test("normalizeText keeps digits (order 993 ≠ order 118) and is script-agnostic", () => {
  assert.equal(normalizeText("Order #993!!"), "order 993");
  assert.notEqual(normalizeText("order 993"), normalizeText("order 118"));
  assert.equal(normalizeText("환불 정책!!"), "환불 정책");
});

test("jaccard: identical is 1, unrelated is low", () => {
  const g = (s) => {
    const set = new Set();
    const t = ` ${s} `;
    for (let i = 0; i < t.length - 2; i++) set.add(t.slice(i, i + 3));
    return set;
  };
  assert.equal(jaccard(g("hello world"), g("hello world")), 1);
  assert.ok(jaccard(g("hello world"), g("zzz qqq xxx")) < 0.2);
});

// ── THE regression: no vacuous passes ────────────────────────────────────────
test("ingested cases are skipped+TODO — they report UNVERIFIED, never PASS", async () => {
  const dir = await project();
  const config = await loadConfig(path.join(dir, "heyllm.yaml"));
  const res = await ingestCases(config, rows(3), { map: MAP, sourceName: "zendesk" });
  assert.equal(res.newCases, 3);

  const doc = YAML.parse(await readFile(res.file, "utf8"));
  for (const cs of doc.cases) {
    assert.ok(typeof cs.skip === "string" && /unreviewed/.test(cs.skip), "every ingested case must be skipped with a reason");
    assert.match(JSON.stringify(cs.rubric), /TODO/, "the rubric must be TODO-marked, not fabricated");
    assert.equal(cs.rubric[0].ask, "binary", "binary, not a 1-10 scale — a complaint is a fulfilment question");
    assert.deepEqual(cs.rubric[0].rules, [
      "TODO: one sentence — what counts as satisfying this.",
      "TODO: one sentence — the closest thing that does NOT count.",
    ], "rules are never machine-guessed — a fabricated policy poisons `heyllm doctor`");
  }

  // and running the suite reports them as skipped, not passed
  const s = await runSuite(await loadConfig(path.join(dir, "heyllm.yaml")));
  const cases = s.layers.find((l) => l.name === "quality").cases;
  assert.equal(cases.length, 3);
  for (const c of cases) assert.ok(c.result.skipped, "an ingested stub must be reported as skipped/unverified");
});

test("un-skipping a stub with TODOs still present is a validate error", async () => {
  const dir = await project();
  const config = await loadConfig(path.join(dir, "heyllm.yaml"));
  await ingestCases(config, rows(1), { map: MAP, sourceName: "zendesk" });
  // simulate a reviewer removing skip: without finishing the rubric
  const file = path.join(dir, "tests/captured.yaml");
  const doc = YAML.parse(await readFile(file, "utf8"));
  delete doc.cases[0].skip;
  await writeFile(file, YAML.stringify(doc));

  const cfg = await loadConfig(path.join(dir, "heyllm.yaml"));
  const layer = cfg.layers[0];
  const problems = validateCases(layer, await loadLayerCases(layer, cfg.baseDir, "tests/captured.yaml"));
  assert.ok(problems.some((p) => /TODO markers/.test(p)), "un-skipping an unfinished stub must be rejected");
});

test("a 50-row skipped backlog produces ZERO validate problems (CI stays green)", async () => {
  const dir = await project();
  const config = await loadConfig(path.join(dir, "heyllm.yaml"));
  await ingestCases(config, rows(50), { map: MAP, sourceName: "zendesk" });
  const cfg = await loadConfig(path.join(dir, "heyllm.yaml"));
  const layer = cfg.layers[0];
  const problems = validateCases(layer, await loadLayerCases(layer, cfg.baseDir, "tests/captured.yaml"));
  assert.deepEqual(problems, [], "a parked backlog must not block CI, or people delete it instead of working it");
});

// ── idempotency, dedup, provenance ───────────────────────────────────────────
test("re-ingesting the same file adds nothing and reports it", async () => {
  const dir = await project();
  const config = await loadConfig(path.join(dir, "heyllm.yaml"));
  const first = await ingestCases(config, rows(3), { map: MAP, sourceName: "zendesk" });
  const bytes1 = await readFile(first.file, "utf8");
  const second = await ingestCases(config, rows(3), { map: MAP, sourceName: "zendesk" });
  assert.equal(second.newCases, 0);
  assert.equal(second.alreadyInLedger, 3);
  assert.equal(await readFile(first.file, "utf8"), bytes1, "a no-op re-ingest must not rewrite the file");
});

test("exact duplicates collapse and keep every id; evidence is never discarded", async () => {
  const dir = await project();
  const config = await loadConfig(path.join(dir, "heyllm.yaml"));
  const dupes = [
    { id: "1", comment: { body: "same complaint" }, fields: { expected: "same expected" } },
    { id: "2", comment: { body: "same complaint" }, fields: { expected: "same expected" } },
  ];
  const res = await ingestCases(config, dupes, { map: MAP, sourceName: "z" });
  assert.equal(res.newCases, 1);
  assert.equal(res.duplicateInBatch, 1);
  const doc = YAML.parse(await readFile(res.file, "utf8"));
  assert.deepEqual(doc.cases[0].source.duplicateIds, ["1", "2"], "duplicateIds sorted and complete");
});

test("provenance keeps the raw complaint byte-verbatim and separate from the prompt", async () => {
  const dir = await project();
  const config = await loadConfig(path.join(dir, "heyllm.yaml"));
  const raw = "  it KEEPS going off-topic!!  ";
  const res = await ingestCases(config, [{ id: "9", comment: { body: raw }, fields: { expected: "quote the policy" } }], {
    map: MAP,
    sourceName: "zendesk",
  });
  const doc = YAML.parse(await readFile(res.file, "utf8"));
  const cs = doc.cases[0];
  assert.equal(cs.source.raw, raw, "raw must be byte-identical — idempotency depends on it surviving prompt edits");
  assert.equal(cs.source.system, "zendesk");
  assert.equal(cs.source.id, "9");
  assert.ok(cs.source.digest);
  assert.equal(cs.name, "ingested-zendesk-9", "content-derived name, stable across re-runs");
});

test("a reviewer's comments survive ingest (parseDocument, not parse+stringify)", async () => {
  const dir = await project({
    "tests/captured.yaml": "# reviewer: confirmed with CS, root cause is the retrieval prompt\ncases: []\n",
  });
  const config = await loadConfig(path.join(dir, "heyllm.yaml"));
  const res = await ingestCases(config, rows(1), { map: MAP, sourceName: "z" });
  const text = await readFile(res.file, "utf8");
  assert.match(text, /# reviewer: confirmed with CS/, "review history must not be silently deleted");
});

test("rows with no usable input abort the whole batch and write nothing", async () => {
  const dir = await project();
  const config = await loadConfig(path.join(dir, "heyllm.yaml"));
  const bad = [{ id: "1", comment: { body: "ok" }, fields: {} }, { id: "2", comment: {}, fields: {} }];
  await assert.rejects(() => ingestCases(config, bad, { map: MAP, sourceName: "z" }), /refusing to write a partial corpus/);
  await assert.rejects(() => readFile(path.join(dir, "tests/captured.yaml"), "utf8"), /ENOENT/);
});

test("--map input is mandatory and unknown targets are rejected", async () => {
  const dir = await project();
  const config = await loadConfig(path.join(dir, "heyllm.yaml"));
  await assert.rejects(() => ingestCases(config, rows(1), { map: { expected: "x" } }), /--map input=.*required/);
  await assert.rejects(() => ingestCases(config, rows(1), { map: { input: "a", bogus: "b" } }), /unknown target 'bogus'/);
});

test("--dry-run reports the plan and writes nothing", async () => {
  const dir = await project();
  const config = await loadConfig(path.join(dir, "heyllm.yaml"));
  const res = await ingestCases(config, rows(2), { map: MAP, sourceName: "z", dryRun: true });
  assert.equal(res.newCases, 2);
  assert.equal(res.dryRun, true);
  await assert.rejects(() => readFile(path.join(dir, "tests/captured.yaml"), "utf8"), /ENOENT/);
});
