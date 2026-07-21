/**
 * conversation layer — drive a real multi-turn endpoint, then judge the whole
 * transcript with a rubric (reusing the judge machinery). A per-turn
 * deterministic failure fails the case regardless of the score.
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig, runSuite } from "../dist/index.js";
import { startMockLLM } from "./mock-llm.js";

let endpoint, base, mock;
test.before(async () => {
  mock = await startMockLLM(); // serves the JUDGE (openai-compatible /v1/chat/completions)
  // conversational endpoint under test: echoes the message; 500 on "boom"
  endpoint = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const b = JSON.parse(body || "{}");
      if (b.message === "boom") { res.writeHead(500); return res.end("{}"); }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: { reply: b.message } }));
    });
  });
  await new Promise((r) => endpoint.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${endpoint.address().port}`;
});
test.after(async () => { await mock.close(); await new Promise((r) => endpoint.close(r)); });

const scaffold = async (yaml) => {
  const dir = await mkdtemp(path.join(tmpdir(), "heyllm-conv-"));
  await writeFile(path.join(dir, "heyllm.yaml"), yaml.replaceAll("{{BASE}}", base).replaceAll("{{MOCK}}", mock.base));
  return dir;
};
const run = async (dir) => runSuite(await loadConfig(path.join(dir, "heyllm.yaml")));
const caseOf = (s, l, n) => s.layers.find((x) => x.name === l)?.cases.find((c) => c.name === n);

const cfg = (turnsYaml) => `
providers:
  j: { kind: openai-compatible, baseUrl: "{{MOCK}}/v1", model: mock-1 }
layers:
  - name: convo
    kind: conversation
    judge: j
    threshold: 7
    cases:
      - name: c
        request: { url: "{{BASE}}/talk" }
        replyPath: data.reply
        rubric:
          - { id: coherent, question: "Does the conversation stay coherent?" }
${turnsYaml}
`;

test("drives the turns, judges the transcript, passes above threshold", async () => {
  const dir = await scaffold(cfg(`        turns:
          - { user: "hello" }
          - { user: "again" }`));
  const r = caseOf(await run(dir), "convo", "c").result;
  assert.equal(r.ok, true, JSON.stringify(r.failures));
  assert.ok(r.score >= 7, `score ${r.score}`);
  assert.equal(r.detail.turns, 2);
});

test("fails when the judge scores the transcript below threshold", async () => {
  // the mock judge scores every item 3 when the evaluated text contains BADWORD;
  // the endpoint echoes it into the transcript.
  const dir = await scaffold(cfg(`        turns:
          - { user: "BADWORD in the reply" }`));
  const r = caseOf(await run(dir), "convo", "c").result;
  assert.equal(r.ok, false, "low transcript score must fail");
  assert.ok(r.score < 7);
});

test("a per-turn deterministic failure fails the case regardless of the score", async () => {
  const dir = await scaffold(cfg(`        turns:
          - { user: "hello" }
          - { user: "boom", expect: { status: 200 } }`));   // endpoint 500s
  const r = caseOf(await run(dir), "convo", "c").result;
  assert.equal(r.ok, false, "a 500 on a turn must fail the case even if the judge liked the rest");
  assert.ok(r.failures.some((f) => /turn\[1\]\.status/.test(f.path)));
});
