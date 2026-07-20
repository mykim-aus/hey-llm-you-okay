/**
 * Subprocess (polyglot) dispatch reducers — F1.
 *
 * Uses a Node one-shot reducer as the fixture so the test matrix needs no
 * Python, plus a POSIX `sh` reducer to prove the wire is genuinely not
 * JS-specific. The load-bearing tests are the ones about SILENT failure: a
 * broken command with zero tool calls must not pass, and stdout noise must
 * never be scanned-past into a fabricated green.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig, runSuite, loadLayerCases, validateCases } from "../dist/index.js";

// One-shot reducer: read one request line, write one response line.
const NODE_REDUCER = `
let buf = "";
process.stdin.on("data", (d) => (buf += d));
process.stdin.on("end", () => {
  const req = JSON.parse(buf.trim().split("\\n")[0]);
  if (req.probe) process.exit(0);
  const { state, call } = req;
  if (call.name === "open_ticket") {
    if (!state.signedIn) return void process.stdout.write(JSON.stringify({ state }) + "\\n");
    return void process.stdout.write(
      JSON.stringify({ state: { ...state, panel: "ticket" }, effects: [{ type: "analytics" }] }) + "\\n"
    );
  }
  if (call.name === "boom") return void process.stdout.write(JSON.stringify({ error: "no handler for boom" }) + "\\n");
  if (call.name === "noisy") {
    process.stdout.write("Loading weights...\\n");
    return void process.stdout.write(JSON.stringify({ state }) + "\\n");
  }
  if (call.name === "badenvelope") return void process.stdout.write(JSON.stringify({ nope: 1 }) + "\\n");
  process.stdout.write(JSON.stringify({ state }) + "\\n");
});
`;

// POSIX sh reducer — echoes the state back. Proves the contract is language-neutral.
const SH_REDUCER = `#!/bin/sh
read line
case "$line" in *'"probe":true'*) exit 0;; esac
printf '{"state":{"seen":true}}\\n'
`;

async function project(yaml, extra = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "heyllm-poly-"));
  await writeFile(path.join(dir, "heyllm.yaml"), yaml);
  await writeFile(path.join(dir, "reducer.cjs"), NODE_REDUCER);
  await writeFile(path.join(dir, "reducer.sh"), SH_REDUCER);
  await chmod(path.join(dir, "reducer.sh"), 0o755);
  for (const [rel, body] of Object.entries(extra)) await writeFile(path.join(dir, rel), body);
  return dir;
}
const run = async (dir) => runSuite(await loadConfig(path.join(dir, "heyllm.yaml")));
const caseOf = (s, n) => s.layers[0].cases.find((c) => c.name === n);

const LAYER = (cases) => `
providers: {}
layers:
  - name: app
    kind: dispatch
    gate: false
    cases:
${cases}
`;

test("a subprocess reducer folds state and effects exactly like the JS path", async () => {
  const dir = await project(
    LAYER(`      - name: gated
        command: node
        args: [reducer.cjs]
        initialState: { signedIn: false }
        calls: [{ name: open_ticket }]
        expect: { state: { signedIn: false } }
      - name: opens
        command: node
        args: [reducer.cjs]
        initialState: { signedIn: true }
        calls: [{ name: open_ticket }]
        expect:
          state: { panel: ticket }
          effects: { $contains: [{ type: analytics }] }`)
  );
  const s = await run(dir);
  assert.equal(caseOf(s, "gated").result.ok, true, "the gate branch must be reachable from a subprocess");
  assert.equal(caseOf(s, "opens").result.ok, true, "state AND effects fold through the same foldCalls");
});

test("the wire is language-neutral — a POSIX sh reducer works", async () => {
  const dir = await project(
    LAYER(`      - name: shell
        command: ./reducer.sh
        initialState: {}
        calls: [{ name: anything }]
        expect: { state: { seen: true } }`)
  );
  const s = await run(dir);
  assert.equal(caseOf(s, "shell").result.ok, true, "no JS anywhere in the reducer");
});

test("stdout noise is a hard failure — never scanned past into a fake green", async () => {
  const dir = await project(
    LAYER(`      - name: noisy
        command: node
        args: [reducer.cjs]
        initialState: {}
        calls: [{ name: noisy }]
        expect: { state: {} }`)
  );
  const s = await run(dir);
  const r = caseOf(s, "noisy").result;
  assert.equal(r.ok, false, "a polluted data channel must fail, not resync onto the next JSON line");
  assert.match(r.failures[0].message, /one JSON response line/);
  assert.match(r.failures[0].message, /diagnostics to stderr/, "the message must name the fix");
});

test("a reducer-reported error is surfaced by name (the signal this layer hunts)", async () => {
  const dir = await project(
    LAYER(`      - name: nohandler
        command: node
        args: [reducer.cjs]
        initialState: {}
        calls: [{ name: boom }]
        expect: { state: {} }`)
  );
  const r = caseOf(await run(dir), "nohandler").result;
  assert.equal(r.ok, false);
  assert.match(r.failures[0].message, /no handler for boom/);
});

test("an envelope with no 'state' key fails, naming the keys it did get", async () => {
  const dir = await project(
    LAYER(`      - name: badenv
        command: node
        args: [reducer.cjs]
        initialState: {}
        calls: [{ name: badenvelope }]
        expect: { state: {} }`)
  );
  const r = caseOf(await run(dir), "badenv").result;
  assert.equal(r.ok, false);
  assert.match(r.failures[0].message, /'state' key/);
});

test("a command that does not exist fails with ENOENT and the cwd", async () => {
  const dir = await project(
    LAYER(`      - name: missing
        command: definitely-not-a-real-binary-xyz
        initialState: {}
        calls: [{ name: x }]
        expect: { state: {} }`)
  );
  const r = caseOf(await run(dir), "missing").result;
  assert.equal(r.ok, false);
  assert.match(r.failures[0].message, /ENOENT/);
  assert.match(r.failures[0].message, /cwd:/);
});

test("mode validation: both/neither/stray keys/shell-looking command", async () => {
  const dir = await project(
    LAYER(`      - name: both
        command: node
        module: ./r.mjs
        calls: [{ name: x }]
      - name: neither
        calls: [{ name: x }]
      - name: stray
        module: ./r.mjs
        args: [x]
        calls: [{ name: x }]
      - name: shelly
        command: "python3 reducer.py"
        calls: [{ name: x }]`)
  );
  const config = await loadConfig(path.join(dir, "heyllm.yaml"));
  const layer = config.layers[0];
  const problems = validateCases(layer, await loadLayerCases(layer, config.baseDir));
  assert.ok(problems.some((p) => /both 'module' and 'command'/.test(p)));
  // the existing config test matches on this literal — keep it exactly one problem
  const neither = problems.filter((p) => /neither/.test(p));
  assert.equal(neither.length, 1, "neither-mode must produce exactly one problem");
  assert.match(neither[0], /needs 'module'/);
  assert.ok(problems.some((p) => /args.*'command' only/.test(p)));
  assert.ok(problems.some((p) => /NOT through a shell/.test(p)));
});

test("a broken command is caught even when the fold has zero calls (no silent no-op)", async () => {
  // The lazy-spawn hazard: with nothing to fold, a reducer that can never start
  // would otherwise never be touched and the case would pass having done nothing.
  const dir = await project(
    LAYER(`      - name: zero
        command: definitely-not-a-real-binary-xyz
        initialState: {}
        calls: [{ name: x }]
        expect: { state: {} }`)
  );
  const r = caseOf(await run(dir), "zero").result;
  assert.equal(r.ok, false, "the eager liveness probe must fail before the fold");
});

// ── regressions from the 0.1.8 adversarial audit ─────────────────────────────

test("REGRESSION: a reducer that STARTS then DIES is caught with zero tool calls", async () => {
  // The probe used to resolve before the exit-code check, so it only ever caught
  // ENOENT. A bad interpreter arg / import error / syntax error — the common
  // real breakage — started, died, and the case passed having never run it.
  // The previous test for this passed `calls: [{name: x}]` (non-zero) AND used a
  // nonexistent binary, so it missed on both axes.
  const dir = await project(LAYER(`      - name: unused
        command: node
        args: [reducer.cjs]
        calls: [{ name: x }]`));
  await writeFile(path.join(dir, "bad.sh"), `#!/bin/sh\necho "Traceback: ImportError" >&2\nexit 1\n`);
  await chmod(path.join(dir, "bad.sh"), 0o755);

  const { runDispatchBlock } = await import("../dist/layers/dispatch.js");
  const failures = [];
  const outcome = await runDispatchBlock(
    { command: "./bad.sh", initialState: { screen: "home" }, expect: { state: { screen: "home" } } },
    [], // ← ZERO tool calls: the exact state the probe exists to protect
    { baseDir: dir, config: { baseDir: dir } },
    failures
  );
  assert.ok(failures.length > 0, "a reducer that exited 1 must not produce a silent green");
  assert.equal(outcome, null);
  assert.match(failures[0].message, /exited 1|never/i);
});

test("REGRESSION: a dispatch: block folding ZERO calls is not a vacuous pass", async () => {
  // With a WORKING reducer and no tool calls, `expect` was scored against the
  // untouched initialState and passed — a green tick for a chain nothing walked.
  const dir = await project(LAYER(`      - name: unused
        command: node
        args: [reducer.cjs]
        calls: [{ name: x }]`));
  const { runDispatchBlock } = await import("../dist/layers/dispatch.js");
  const failures = [];
  await runDispatchBlock(
    { command: "node", args: ["reducer.cjs"], initialState: { screen: "home" }, expect: { state: { screen: "home" } } },
    [],
    { baseDir: dir, config: { baseDir: dir } },
    failures
  );
  assert.ok(failures.length > 0, "zero folded calls verified nothing about the app");
  assert.match(failures[0].message, /no tool calls/);
});

test("REGRESSION: the dispatch: block enforces the mode rules too", async () => {
  const dir = await project(LAYER(`      - name: unused
        command: node
        args: [reducer.cjs]
        calls: [{ name: x }]`));
  const { runDispatchBlock } = await import("../dist/layers/dispatch.js");
  const failures = [];
  await runDispatchBlock(
    { command: "node", module: "./r.mjs", initialState: {}, expect: {} },
    [{ name: "x", args: {} }],
    { baseDir: dir, config: { baseDir: dir } },
    failures
  );
  assert.ok(failures.some((f) => /both 'module' and 'command'/.test(f.message)), "mode rules must apply to the embedded block");
});
