/**
 * Regressions for bugs found by dogfooding + adversarial review.
 * Every test here maps to a real failure mode, not a hypothetical.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, readFile, symlink } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, runSuite, captureCase, loadLayerCases, validateCases } from "../dist/index.js";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "../dist/cli.js");

const scaffold = async (files) => {
  const dir = await mkdtemp(path.join(tmpdir(), "heyllm-hard-"));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, content);
  }
  return dir;
};

test("`heyllm init` scaffold actually runs (file: refs resolve from the case file)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "heyllm-init-"));
  execFileSync("node", [CLI, "init"], { cwd: dir, stdio: "pipe" });
  execFileSync("node", [CLI, "validate"], { cwd: dir, stdio: "pipe" });
  // static layer must find prompts/assistant.txt from tests/static/
  const out = execFileSync("node", [CLI, "run", "--only", "static"], { cwd: dir, encoding: "utf8" });
  assert.match(out, /2\/2/, out);
  assert.match(out, /RESULT: PASS/, out);
});

test("exec layer preserves multi-byte output (chunk-boundary safe)", async () => {
  // Deliberately multi-byte: a 3-byte-per-char string is what makes a chunk
  // boundary land mid-character. An ASCII string would never exercise this.
  const long = "한글출력테스트".repeat(12000); // ≫ 64KB, splits mid-character
  const dir = await scaffold({
    "heyllm.yaml": `
providers: {}
layers:
  - name: e
    kind: exec
    cases:
      - { name: utf8, command: "node -e \\"process.stdout.write(require('fs').readFileSync('big.txt','utf8'))\\"", expect: { stdout: { $notContains: "\\uFFFD" } } }
`,
    "big.txt": long,
  });
  const s = await runSuite(await loadConfig(path.join(dir, "heyllm.yaml")));
  assert.equal(s.layers[0].cases[0].result.ok, true, JSON.stringify(s.layers[0].cases[0].result.failures));
});

test("exec timeout kills the whole process tree (no orphan hang)", async () => {
  const dir = await scaffold({
    "heyllm.yaml": `
providers: {}
layers:
  - name: e
    kind: exec
    gate: false
    cases:
      - { name: hangs, command: "node -e 'setTimeout(()=>{},60000)' & wait", timeoutMs: 1200 }
`,
  });
  const started = Date.now();
  const s = await runSuite(await loadConfig(path.join(dir, "heyllm.yaml")));
  const elapsed = Date.now() - started;
  assert.equal(s.layers[0].cases[0].result.ok, false);
  assert.ok(elapsed < 15000, `runner should not hang past the timeout (took ${elapsed}ms)`);
});

test("capture REFUSES a malformed ledger instead of overwriting it", async () => {
  const broken = "cases:\n  - name: keep-me\n   bad-indent: [unclosed\n";
  const dir = await scaffold({
    "heyllm.yaml": `
providers:
  m: { kind: openai-compatible, baseUrl: http://x, model: m }
settings: { capture: { file: tests/captured.yaml } }
layers:
  - { name: b, kind: llm, provider: m, include: "tests/*.yaml" }
`,
    "tests/captured.yaml": broken,
  });
  const config = await loadConfig(path.join(dir, "heyllm.yaml"));
  await assert.rejects(() => captureCase(config, "new input"), /not valid YAML|refusing to overwrite/);
  assert.equal(await readFile(path.join(dir, "tests/captured.yaml"), "utf8"), broken); // untouched
});

test("validate rejects unknown case keys (mis-indented expect would assert nothing)", async () => {
  const dir = await scaffold({
    "heyllm.yaml": `
providers:
  m: { kind: openai-compatible, baseUrl: http://x, model: m }
layers:
  - { name: b, kind: llm, provider: m, include: "tests/*.yaml" }
`,
    // `expct` typo: the case would run with NO assertions and pass forever
    "tests/a.yaml": `cases:\n  - name: typo\n    prompt: hi\n    expct: { text: hello }\n`,
  });
  const config = await loadConfig(path.join(dir, "heyllm.yaml"));
  const problems = validateCases(config.layers[0], await loadLayerCases(config.layers[0], config.baseDir));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /unknown key 'expct'/);
});

test("--grep with a missing value is a usage error, not a silent all-filtered PASS", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "heyllm-grep-"));
  execFileSync("node", [CLI, "init"], { cwd: dir, stdio: "pipe" });
  let code = 0;
  let stderr = "";
  try {
    execFileSync("node", [CLI, "run", "--only", "static", "--grep"], { cwd: dir, stdio: "pipe" });
  } catch (e) {
    code = e.status;
    stderr = String(e.stderr);
  }
  assert.equal(code, 2, "must exit 2 (usage error)");
  assert.match(stderr, /--grep requires a value/);
});

test("--version prints the version (not the help screen)", () => {
  const out = execFileSync("node", [CLI, "--version"], { encoding: "utf8" });
  assert.match(out.trim(), /^heyllm \d+\.\d+\.\d+$/);
});

test("settings.envFile loads keys; real env always wins", async () => {
  const dir = await scaffold({
    "heyllm.yaml": `
providers: {}
settings: { envFile: .env.test }
layers:
  - { name: s, kind: static, cases: [{ name: x, file: heyllm.yaml }] }
`,
    ".env.test": `HEYLLM_FROM_FILE=loaded\nexport HEYLLM_QUOTED="q v"\nHEYLLM_ALREADY=from-file\n`,
  });
  process.env.HEYLLM_ALREADY = "from-shell";
  await loadConfig(path.join(dir, "heyllm.yaml"));
  assert.equal(process.env.HEYLLM_FROM_FILE, "loaded");
  assert.equal(process.env.HEYLLM_QUOTED, "q v");
  assert.equal(process.env.HEYLLM_ALREADY, "from-shell"); // shell/CI secret wins
  delete process.env.HEYLLM_FROM_FILE;
  delete process.env.HEYLLM_QUOTED;
  delete process.env.HEYLLM_ALREADY;
});

test("exec: ref runs from the PROJECT ROOT, not the case file's directory", async () => {
  const dir = await scaffold({
    "heyllm.yaml": `
providers:
  m: { kind: openai-compatible, baseUrl: http://127.0.0.1:1/v1, model: m }
layers:
  - { name: b, kind: llm, provider: m, gate: false, include: "tests/deep/*.yaml" }
`,
    "root-only.js": `console.log("SAY: FROM-ROOT");`,
    // the case lives 2 levels down; `node root-only.js` only resolves from the root
    "tests/deep/c.yaml": `cases:\n  - name: r\n    system: "exec:node root-only.js"\n    prompt: hi\n`,
  });
  const config = await loadConfig(path.join(dir, "heyllm.yaml"));
  const { resolveLlmInputs } = await import("../dist/layers/llm.js");
  const layer = config.layers[0];
  const groups = await loadLayerCases(layer, config.baseDir);
  const ctx = {
    layer,
    providers: {},
    baseDir: path.join(dir, "tests/deep"),
    saved: {},
    lookup: () => undefined,
    config,
  };
  const inputs = await resolveLlmInputs(groups[0].cases[0], ctx);
  assert.equal(inputs.system, "SAY: FROM-ROOT");
});

test("non-JSON body: json/jsonPath FAIL loudly (no silent false-pass on negatives)", async () => {
  const { applyExpect } = await import("../dist/index.js");
  const actual = { text: "hello, not json", json: undefined };
  // the killer case: model produced no structured output at all, yet a
  // negative assertion used to pass
  const neg = applyExpect({ jsonPath: { "data.uiAction": { $notContains: "start_roleplay" } } }, actual, []);
  assert.equal(neg.length, 1);
  assert.match(neg[0].message, /not JSON/);
  const negJson = applyExpect({ json: { $ne: { bad: true } } }, actual, []);
  assert.equal(negJson.length, 1);
  // explicit absence assertions remain legal
  assert.equal(applyExpect({ json: { $exists: false } }, actual, []).length, 0);
  assert.equal(applyExpect({ jsonPath: { "a.b": { $exists: false } } }, actual, []).length, 0);
});

test("invalid regex is reported as an authoring error, not a provider failure", async () => {
  const { matchValue } = await import("../dist/index.js");
  const f = [];
  matchValue({ $pattern: "(?i)hello" }, "HELLO", "text", f); // JS has no inline (?i)
  assert.equal(f.length, 1);
  assert.match(f[0].message, /invalid \$pattern regex/);
  assert.match(f[0].message, /\$flags/);
});

test("llm case rejects keys that only exist on other layers", async () => {
  const { checkLlmExpect } = await import("../dist/layers/llm.js");
  const actual = { text: "hi", fullText: "hi", json: undefined, toolCalls: [], toolNames: [] };
  const f = [];
  checkLlmExpect({ status: 200 }, actual, f);
  assert.equal(f.length, 1);
  assert.match(f[0].message, /not available on an llm case/);
});

test("capture warns when the ledger is unreachable from the layer's include", async () => {
  const dir = await scaffold({
    "heyllm.yaml": `
providers:
  m: { kind: openai-compatible, baseUrl: http://x, model: m }
settings: { capture: { file: ledger/out.yaml } }
layers:
  - { name: b, kind: llm, provider: m, include: "tests/*.yaml" }
`,
    "tests/a.yaml": `cases: [{ name: seed, prompt: hi }]`,
  });
  const config = await loadConfig(path.join(dir, "heyllm.yaml"));
  const res = await captureCase(config, "unreachable input");
  assert.equal(res.reachable, false, "ledger/out.yaml is not matched by tests/*.yaml");

  // and the reachable case reports true
  const dir2 = await scaffold({
    "heyllm.yaml": `
providers:
  m: { kind: openai-compatible, baseUrl: http://x, model: m }
settings: { capture: { file: tests/captured.yaml } }
layers:
  - { name: b, kind: llm, provider: m, include: "tests/*.yaml" }
`,
    "tests/a.yaml": `cases: [{ name: seed, prompt: hi }]`,
  });
  const res2 = await captureCase(await loadConfig(path.join(dir2, "heyllm.yaml")), "reachable input");
  assert.equal(res2.reachable, true);
});

test("judgeParams.temperature: null omits the parameter (reasoning models reject it)", async () => {
  const { createProviders } = await import("../dist/index.js");
  let captured = null;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    captured = JSON.parse(init.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const p = createProviders({ m: { kind: "openai-compatible", baseUrl: "http://x/v1", model: "m" } });
    await p.m.chat({ messages: [{ role: "user", content: "hi" }], temperature: undefined });
    assert.equal("temperature" in captured, false, "undefined temperature must not be sent");
    await p.m.chat({ messages: [{ role: "user", content: "hi" }], temperature: 0 });
    assert.equal(captured.temperature, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("glob follows symlinked files (parity with exact non-glob paths)", async () => {
  const { symlink } = await import("node:fs/promises");
  const dir = await scaffold({
    "real/prompt.txt": "SAFETY rules here\n",
    "heyllm.yaml": `
providers: {}
layers:
  - name: s
    kind: static
    cases:
      - { name: via-glob, files: "linked/*.txt", require: [{ pattern: "SAFETY" }] }
`,
  });
  await mkdir(path.join(dir, "linked"), { recursive: true });
  await symlink(path.join(dir, "real/prompt.txt"), path.join(dir, "linked/prompt.txt"));
  const s = await runSuite(await loadConfig(path.join(dir, "heyllm.yaml")));
  const r = s.layers[0].cases[0].result;
  assert.equal(r.ok, true, JSON.stringify(r.failures));
  assert.equal(r.detail.files, 1);
});

test("http redirect: manual lets a case assert the 3xx itself", async () => {
  const http = await import("node:http");
  const server = http.createServer((req, res) => {
    if (req.url === "/old") {
      res.writeHead(301, { location: "/new" });
      return res.end();
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"ok":true}');
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const dir = await scaffold({
      "heyllm.yaml": `
providers: {}
layers:
  - name: api
    kind: http
    cases:
      - name: asserts-301
        request: { url: "${base}/old", redirect: manual }
        expect: { status: 301, headers: { location: /new } }
      - name: follows-by-default
        request: { url: "${base}/old" }
        expect: { status: 200, json: { ok: true } }
`,
    });
    const s = await runSuite(await loadConfig(path.join(dir, "heyllm.yaml")));
    assert.equal(s.layers[0].cases[0].result.ok, true, JSON.stringify(s.layers[0].cases[0].result.failures));
    assert.equal(s.layers[0].cases[1].result.ok, true, JSON.stringify(s.layers[0].cases[1].result.failures));
  } finally {
    await new Promise((r) => server.close(r));
  }
});

// ── second wave: verified by the adversarial review's reproduction scripts ──

const dumpBody = async (providerCfg, req) => {
  const { createProviders } = await import("../dist/index.js");
  let body = null;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_u, init) => {
    body = JSON.parse(init.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }], content: [], candidates: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    await createProviders({ p: providerCfg }).p.chat(req);
  } finally {
    globalThis.fetch = realFetch;
  }
  return body;
};

test("temperature: null is OMITTED by every provider (null used to be serialized → 400)", async () => {
  const req = { messages: [{ role: "user", content: "hi" }], temperature: null };
  for (const cfg of [
    { kind: "openai-compatible", baseUrl: "http://x/v1", model: "gpt-4o" },
    { kind: "anthropic", baseUrl: "http://x", model: "claude-sonnet-4-5", apiKeyEnv: "NONE" },
    { kind: "gemini", baseUrl: "http://x", model: "gemini-2.5-flash", apiKeyEnv: "NONE" },
  ]) {
    process.env.NONE = "k";
    const body = await dumpBody(cfg, req);
    const where = cfg.kind === "gemini" ? body.generationConfig || {} : body;
    assert.equal("temperature" in where, false, `${cfg.kind} must omit null temperature`);
  }
  delete process.env.NONE;
});

test("reasoning models: temperature omitted + max_completion_tokens used", async () => {
  const req = { messages: [{ role: "user", content: "hi" }], temperature: 0, maxTokens: 512 };
  const o3 = await dumpBody({ kind: "openai-compatible", baseUrl: "http://x/v1", model: "o3-mini" }, req);
  assert.equal("temperature" in o3, false);
  assert.equal(o3.max_completion_tokens, 512);
  assert.equal("max_tokens" in o3, false);

  const gpt4 = await dumpBody({ kind: "openai-compatible", baseUrl: "http://x/v1", model: "gpt-4o" }, req);
  assert.equal(gpt4.temperature, 0);
  assert.equal(gpt4.max_tokens, 512);

  process.env.NONE = "k";
  const newClaude = await dumpBody(
    { kind: "anthropic", baseUrl: "http://x", model: "claude-opus-4-8", apiKeyEnv: "NONE" },
    req
  );
  assert.equal("temperature" in newClaude, false, "newer Claude models reject sampling params");
  delete process.env.NONE;
});

test("gemini: non-object tool fixtures are wrapped into a Struct; signature round-trips", async () => {
  process.env.NONE = "k";
  const body = await dumpBody(
    { kind: "gemini", baseUrl: "http://x", model: "gemini-3-pro-preview", apiKeyEnv: "NONE" },
    {
      messages: [
        { role: "user", content: "weather?" },
        { role: "assistant", toolCalls: [{ name: "get_weather", args: {}, signature: "SIG_ABC" }] },
        {
          role: "tool",
          toolResults: [
            { name: "get_weather", response: "sunny, 21C" }, // plain text fixture
            { name: "arr", response: [1, 2] },
            { name: "obj", response: { temp: 21 } },
          ],
        },
      ],
    }
  );
  delete process.env.NONE;
  const fr = body.contents.flatMap((c) => c.parts).filter((p) => p.functionResponse);
  assert.deepEqual(fr[0].functionResponse.response, { result: "sunny, 21C" });
  assert.deepEqual(fr[1].functionResponse.response, { result: [1, 2] });
  assert.deepEqual(fr[2].functionResponse.response, { temp: 21 }); // objects pass through
  const fc = body.contents.flatMap((c) => c.parts).find((p) => p.functionCall);
  assert.equal(fc.thoughtSignature, "SIG_ABC");
});

test("{{VAR}} expands ONLY declared env vars (no prompt pollution, no secrets in baseline)", async () => {
  process.env.HEYLLM_DECLARED = "declared-value";
  process.env.HEYLLM_SECRET_KEY = "sk-must-never-appear";
  const dir = await scaffold({
    "heyllm.yaml": `
providers:
  m: { kind: openai-compatible, baseUrl: http://127.0.0.1:1/v1, model: m }
layers:
  - name: b
    kind: llm
    provider: m
    gate: false
    env: [HEYLLM_DECLARED]
    cases:
      - name: c
        system: "declared={{HEYLLM_DECLARED}} secret={{HEYLLM_SECRET_KEY}} tpl={{USER}}"
        prompt: hi
`,
  });
  const config = await loadConfig(path.join(dir, "heyllm.yaml"));
  const { resolveLlmInputs } = await import("../dist/layers/llm.js");
  const layer = config.layers[0];
  const groups = await loadLayerCases(layer, config.baseDir);
  const envScope = Object.fromEntries((layer.env || []).map((k) => [k, process.env[k]]));
  const { makeLookup } = await import("../dist/util.js");
  const inputs = await resolveLlmInputs(groups[0].cases[0], {
    layer,
    providers: {},
    baseDir: config.baseDir,
    saved: {},
    lookup: makeLookup(envScope, layer.vars, {}),
    config,
  });
  assert.match(inputs.system, /declared=declared-value/);
  assert.match(inputs.system, /secret=\{\{HEYLLM_SECRET_KEY\}\}/, "undeclared secret must stay literal");
  assert.match(inputs.system, /tpl=\{\{USER\}\}/, "template placeholders must not collide with env");
  delete process.env.HEYLLM_DECLARED;
  delete process.env.HEYLLM_SECRET_KEY;
});

test("$contains compares scalars symmetrically across strings and arrays", async () => {
  const { matchValue } = await import("../dist/index.js");
  const fails = (spec, got) => {
    const f = [];
    matchValue(spec, got, "x", f);
    return f.length;
  };
  assert.equal(fails({ $contains: 23 }, "order 23 ready"), 0);
  assert.equal(fails({ $contains: 23 }, ["23", "24"]), 0, "number needle vs string array");
  assert.equal(fails({ $contains: "23" }, [23, 24]), 0, "string needle vs number array");
  assert.equal(fails({ $notContains: 23 }, ["23"]), 1, "negative form must catch it too");
  assert.equal(fails({ $contains: 99 }, ["23"]), 1);
});

test("exec case rejects http/llm-only expect keys", async () => {
  const dir = await scaffold({
    "heyllm.yaml": `
providers: {}
layers:
  - name: e
    kind: exec
    gate: false
    cases:
      - { name: wrong-keys, command: "echo hi", expect: { status: { $ne: 500 }, text: { $notContains: "err" } } }
`,
  });
  const s = await runSuite(await loadConfig(path.join(dir, "heyllm.yaml")));
  const r = s.layers[0].cases[0].result;
  assert.equal(r.ok, false, "used to silently pass");
  assert.equal(r.failures.filter((f) => /not available on an exec case/.test(f.message)).length, 2);
});

test("validate lints regexes pre-flight (a typo costs 0 paid model calls)", async () => {
  const dir = await scaffold({
    "heyllm.yaml": `
providers:
  m: { kind: openai-compatible, baseUrl: http://x, model: m }
layers:
  - { name: b, kind: llm, provider: m, include: "tests/*.yaml" }
`,
    "tests/a.yaml": `cases:
  - name: bad-regex
    prompt: hi
    expect: { text: { $pattern: "(?i)foo" } }
`,
  });
  const config = await loadConfig(path.join(dir, "heyllm.yaml"));
  const problems = validateCases(config.layers[0], await loadLayerCases(config.layers[0], config.baseDir));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /invalid \$pattern/);
  assert.match(problems[0], /\$flags/);
});

test("bin entry: runs when invoked through a node_modules/.bin style symlink", async () => {
  // npm links the `heyllm` bin as a symlink to dist/cli.js, so argv[1] is the
  // link path while import.meta.url is the real file. A basename comparison
  // fails that match and main() silently never runs — exit 0, no output.
  const dir = await mkdtemp(path.join(tmpdir(), "heyllm-bin-"));
  const link = path.join(dir, "heyllm");
  await symlink(CLI, link);
  const out = execFileSync("node", [link, "--help"], { encoding: "utf8" });
  assert.match(out, /commands:/, "help must print when invoked via the bin symlink");
});

test("a typo'd --only layer name fails loudly instead of passing 0 cases", async () => {
  // Before 0.1.5: `--only behaviour` (British spelling of a layer named
  // `behavior`) selected nothing and printed "RESULT: PASS — 0/0 cases" with
  // exit 0. One wrong character in a CI command turned the entire gate green
  // while claiming to have run. Selecting nothing is never a pass.
  const dir = await scaffold({
    "heyllm.yaml": `
layers:
  - name: behavior
    kind: exec
    cases:
      - { name: ok, command: "true" }
`,
  });
  let code = 0;
  let out = "";
  try {
    execFileSync("node", [CLI, "run", "--only", "behaviour"], { cwd: dir, stdio: "pipe" });
  } catch (e) {
    code = e.status;
    out = String(e.stdout || "") + String(e.stderr || "");
  }
  assert.equal(code, 2, "a config/selection mistake exits 2, not 0");
  assert.match(out, /unknown layer[s]? in --only: behaviour/);
  assert.match(out, /available: behavior/, "must show what the valid names are");

  // the correctly-spelled name still works
  const okOut = execFileSync("node", [CLI, "run", "--only", "behavior"], { cwd: dir, stdio: "pipe" });
  assert.match(String(okOut), /1\/1 cases/);
});

test("--grep that matches nothing does not report PASS", async () => {
  const dir = await scaffold({
    "heyllm.yaml": `
layers:
  - name: behavior
    kind: exec
    cases:
      - { name: ok, command: "true" }
`,
  });
  let code = 0;
  let out = "";
  try {
    execFileSync("node", [CLI, "run", "--grep", "nothing-matches-this"], { cwd: dir, stdio: "pipe" });
  } catch (e) {
    code = e.status;
    out = String(e.stdout || "") + String(e.stderr || "");
  }
  assert.equal(code, 2);
  assert.match(out, /nothing was measured/);
});

test("`run --help` prints help and NEVER executes the suite", async () => {
  // Measured 2026-07-21: `heyllm run --help` fell through to cmdRun and ran the
  // whole pyramid — in a project whose default layers include paid llm/judge
  // calls, asking for help started a live billed run. A canary case writes a
  // file; if the file exists after --help, the suite executed.
  const dir = await scaffold({
    "heyllm.yaml": `
layers:
  - name: canary
    kind: exec
    cases:
      - { name: proof, command: "echo EXECUTED > ran.txt" }
`,
  });
  for (const cmd of [["run", "--help"], ["triage", "--help"]]) {
    const out = execFileSync("node", [CLI, ...cmd], { cwd: dir, stdio: "pipe" }).toString();
    assert.match(out, /--changed-only|usage|common flags/i, `${cmd.join(" ")} prints help`);
    await assert.rejects(
      () => import("node:fs/promises").then((fs) => fs.access(path.join(dir, "ran.txt"))),
      undefined,
      `${cmd.join(" ")} must not execute cases`
    );
  }
});

test("inputs.mustContain: a resolved-but-degraded system prompt fails before any model call", async () => {
  // The 0-byte floor cannot see this: 54k bytes came back, just missing the
  // DB-derived case-list section. mustContain names one marker per assembled
  // section; a builder that "succeeds" without it fails the case at zero cost.
  const dir = await scaffold({
    "prompts/full.txt": "You are a tutor.\nCASE LIST:\nCase 1: greetings\nCase 2: orders\n",
    "prompts/degraded.txt": "You are a tutor.\n(sections missing — db was down)\n",
    "heyllm.yaml": `
providers:
  fake: { kind: command, command: "echo", outputPath: null }
layers:
  - name: chat
    kind: llm
    provider: fake
    inputs: { system: file, mustContain: ["Case 1:"] }
    cases:
      - { name: ok,       system: "file:prompts/full.txt",     prompt: hi, expect: { text: { $exists: true } } }
      - { name: degraded, system: "file:prompts/degraded.txt", prompt: hi, expect: { text: { $exists: true } } }
`,
  });
  const summary = await runSuite(await loadConfig(path.join(dir, "heyllm.yaml")));
  const byName = (n) => summary.layers[0].cases.find((c) => c.name === n).result;
  assert.equal(byName("ok").ok, true);
  const bad = byName("degraded");
  assert.equal(bad.ok, false);
  assert.match(bad.failures[0].message, /missing the declared marker "Case 1:"/);
  assert.match(bad.failures[0].message, /DEGRADED/);
});

test("inputs.mustContain: empty list / empty marker is a config error, not a silent no-op", async () => {
  for (const mc of ["[]", '[""]', '["ok", "  "]']) {
    const dir = await scaffold({
      "heyllm.yaml": `
providers:
  fake: { kind: command, command: "echo", outputPath: null }
layers:
  - name: chat
    kind: llm
    provider: fake
    inputs: { mustContain: ${mc} }
    cases: [{ name: x, prompt: hi }]
`,
    });
    await assert.rejects(() => loadConfig(path.join(dir, "heyllm.yaml")), /mustContain: must be a non-empty list/);
  }
});
