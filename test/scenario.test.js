/**
 * scenario layer — multi-turn integration: drive a conversational endpoint over
 * N turns, threading the running history back into each request, asserting the
 * response after each turn. The bug class a single request can't reach.
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig, runSuite, loadLayerCases, validateCases } from "../dist/index.js";

const validateProblems = async (dir) => {
  const cfg = await loadConfig(path.join(dir, "heyllm.yaml"));
  let problems = [];
  for (const layer of cfg.layers) {
    const groups = await loadLayerCases(layer, cfg.baseDir, cfg.settings?.capture?.file);
    problems = problems.concat(validateCases(layer, groups));
  }
  return problems;
};

// A tiny conversational endpoint that ECHOES the history it was sent, so a test
// can prove turn 2 actually received turn 1's exchange.
let server, base;
test.before(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const b = JSON.parse(body || "{}");
      if (b.message === "boom") { res.writeHead(500); return res.end("{}"); }
      const hist = Array.isArray(b.history) ? b.history : [];
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        data: { reply: b.message, turnsSeen: hist.length, firstUser: hist[0]?.content ?? null, auth: req.headers["x-token"] || null },
      }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => new Promise((r) => server.close(r)));

const scaffold = async (yaml) => {
  const dir = await mkdtemp(path.join(tmpdir(), "heyllm-scn-"));
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "heyllm.yaml"), yaml.replaceAll("{{BASE}}", base));
  return dir;
};
const run = async (dir) => runSuite(await loadConfig(path.join(dir, "heyllm.yaml")));
const caseOf = (s, l, n) => s.layers.find((x) => x.name === l)?.cases.find((c) => c.name === n);

test("threads history across turns and asserts each turn's response", async () => {
  const dir = await scaffold(`
providers: {}
layers:
  - name: convo
    kind: scenario
    cases:
      - name: two-turns
        request: { url: "{{BASE}}/talk", headers: { x-token: "abc" } }
        replyPath: data.reply
        turns:
          - user: "hello"
            expect: { status: 200, json: { data: { turnsSeen: 0, firstUser: null, auth: abc } } }
          - user: "again"
            expect: { json: { data: { turnsSeen: 2, firstUser: hello } } }
`);
  const s = await run(dir);
  const r = caseOf(s, "convo", "two-turns").result;
  assert.equal(r.ok, true, JSON.stringify(r.failures));
  assert.equal(r.detail.turns, 2);
});

test("a wrong per-turn expectation fails with the turn index", async () => {
  const dir = await scaffold(`
providers: {}
layers:
  - name: convo
    kind: scenario
    cases:
      - name: bad-turn
        request: { url: "{{BASE}}/talk" }
        replyPath: data.reply
        turns:
          - user: "hello"
            expect: { json: { data: { turnsSeen: 0 } } }
          - user: "again"
            expect: { json: { data: { turnsSeen: 99 } } }   # WRONG — it's 2
`);
  const r = caseOf(await run(dir), "convo", "bad-turn").result;
  assert.equal(r.ok, false);
  assert.match(r.failures[0].path, /turn\[1\]\.json\.data\.turnsSeen/);
});

test("[review#1] a typo'd turn key (expct) is caught by validate — not silently dropped", async () => {
  const dir = await scaffold(`
providers: {}
layers:
  - name: convo
    kind: scenario
    cases:
      - name: bad-turn-key
        request: { url: "{{BASE}}/talk" }
        turns:
          - { user: "delete account", expct: { status: 403 } }   # typo → would drop the assertion
`);
  const problems = await validateProblems(dir);
  assert.ok(problems.some((p) => /unknown scenario turn key 'expct'/.test(p)), problems.join("\n"));
});

test("[review#4] a case-level expect on a scenario is rejected (per-turn only)", async () => {
  const dir = await scaffold(`
providers: {}
layers:
  - name: convo
    kind: scenario
    cases:
      - name: case-level-expect
        request: { url: "{{BASE}}/talk" }
        expect: { status: 200 }
        turns: [ { user: "hi", expect: { status: 200 } } ]
`);
  const problems = await validateProblems(dir);
  assert.ok(problems.some((p) => /scenario asserts per turn/.test(p)), problems.join("\n"));
});

test("[review#5] a turn with no expect still fails on a 4xx/5xx (never a silent green)", async () => {
  const dir = await scaffold(`
providers: {}
layers:
  - name: convo
    kind: scenario
    cases:
      - name: no-expect-500
        request: { url: "{{BASE}}/talk" }
        turns: [ { user: "boom" } ]
`);
  // the endpoint 500s on "boom". No expect on the turn, but ≥400 must fail.
  const r = caseOf(await run(dir), "convo", "no-expect-500").result;
  assert.equal(r.ok, false, "a 5xx with no expect must fail, not pass");
  assert.match(r.failures[0].message, /HTTP 500/);
});

test("gate defaults to false (real-model-backed, non-deterministic)", async () => {
  const dir = await scaffold(`
providers: {}
layers:
  - name: convo
    kind: scenario
    cases:
      - name: t
        request: { url: "{{BASE}}/talk" }
        turns: [ { user: "hi", expect: { status: 200 } } ]
`);
  const cfg = await loadConfig(path.join(dir, "heyllm.yaml"));
  assert.equal(cfg.layers[0].gate, false);
});
