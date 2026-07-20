/**
 * Regressions for bugs found by dogfooding + adversarial review.
 * Every test here maps to a real failure mode, not a hypothetical.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, runSuite, captureCase, loadLayerCases, validateCases } from "../dist/index.js";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "../dist/cli.js");

const scaffold = async (files) => {
  const dir = await mkdtemp(path.join(tmpdir(), "haechi-hard-"));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, content);
  }
  return dir;
};

test("`haechi init` scaffold actually runs (file: refs resolve from the case file)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "haechi-init-"));
  execFileSync("node", [CLI, "init"], { cwd: dir, stdio: "pipe" });
  execFileSync("node", [CLI, "validate"], { cwd: dir, stdio: "pipe" });
  // static layer must find prompts/assistant.txt from tests/static/
  const out = execFileSync("node", [CLI, "run", "--only", "static"], { cwd: dir, encoding: "utf8" });
  assert.match(out, /2\/2/, out);
  assert.match(out, /RESULT: PASS/, out);
});

test("exec layer preserves multi-byte output (chunk-boundary safe)", async () => {
  const long = "한글출력테스트".repeat(12000); // ≫ 64KB, splits mid-character
  const dir = await scaffold({
    "haechi.yaml": `
providers: {}
layers:
  - name: e
    kind: exec
    cases:
      - { name: utf8, command: "node -e \\"process.stdout.write(require('fs').readFileSync('big.txt','utf8'))\\"", expect: { stdout: { $notContains: "\\uFFFD" } } }
`,
    "big.txt": long,
  });
  const s = await runSuite(await loadConfig(path.join(dir, "haechi.yaml")));
  assert.equal(s.layers[0].cases[0].result.ok, true, JSON.stringify(s.layers[0].cases[0].result.failures));
});

test("exec timeout kills the whole process tree (no orphan hang)", async () => {
  const dir = await scaffold({
    "haechi.yaml": `
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
  const s = await runSuite(await loadConfig(path.join(dir, "haechi.yaml")));
  const elapsed = Date.now() - started;
  assert.equal(s.layers[0].cases[0].result.ok, false);
  assert.ok(elapsed < 15000, `runner should not hang past the timeout (took ${elapsed}ms)`);
});

test("capture REFUSES a malformed ledger instead of overwriting it", async () => {
  const broken = "cases:\n  - name: keep-me\n   bad-indent: [unclosed\n";
  const dir = await scaffold({
    "haechi.yaml": `
providers:
  m: { kind: openai-compatible, baseUrl: http://x, model: m }
settings: { capture: { file: tests/captured.yaml } }
layers:
  - { name: b, kind: llm, provider: m, include: "tests/*.yaml" }
`,
    "tests/captured.yaml": broken,
  });
  const config = await loadConfig(path.join(dir, "haechi.yaml"));
  await assert.rejects(() => captureCase(config, "새 입력"), /not valid YAML|refusing to overwrite/);
  assert.equal(await readFile(path.join(dir, "tests/captured.yaml"), "utf8"), broken); // untouched
});

test("validate rejects unknown case keys (mis-indented expect would assert nothing)", async () => {
  const dir = await scaffold({
    "haechi.yaml": `
providers:
  m: { kind: openai-compatible, baseUrl: http://x, model: m }
layers:
  - { name: b, kind: llm, provider: m, include: "tests/*.yaml" }
`,
    // `expct` typo: the case would run with NO assertions and pass forever
    "tests/a.yaml": `cases:\n  - name: typo\n    prompt: hi\n    expct: { text: hello }\n`,
  });
  const config = await loadConfig(path.join(dir, "haechi.yaml"));
  const problems = validateCases(config.layers[0], await loadLayerCases(config.layers[0], config.baseDir));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /unknown key 'expct'/);
});

test("--grep with a missing value is a usage error, not a silent all-filtered PASS", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "haechi-grep-"));
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
  assert.match(out.trim(), /^haechi \d+\.\d+\.\d+$/);
});

test("settings.envFile loads keys; real env always wins", async () => {
  const dir = await scaffold({
    "haechi.yaml": `
providers: {}
settings: { envFile: .env.test }
layers:
  - { name: s, kind: static, cases: [{ name: x, file: haechi.yaml }] }
`,
    ".env.test": `HAECHI_FROM_FILE=loaded\nexport HAECHI_QUOTED="q v"\nHAECHI_ALREADY=from-file\n`,
  });
  process.env.HAECHI_ALREADY = "from-shell";
  await loadConfig(path.join(dir, "haechi.yaml"));
  assert.equal(process.env.HAECHI_FROM_FILE, "loaded");
  assert.equal(process.env.HAECHI_QUOTED, "q v");
  assert.equal(process.env.HAECHI_ALREADY, "from-shell"); // shell/CI secret wins
  delete process.env.HAECHI_FROM_FILE;
  delete process.env.HAECHI_QUOTED;
  delete process.env.HAECHI_ALREADY;
});

test("exec: ref runs from the PROJECT ROOT, not the case file's directory", async () => {
  const dir = await scaffold({
    "haechi.yaml": `
providers:
  m: { kind: openai-compatible, baseUrl: http://127.0.0.1:1/v1, model: m }
layers:
  - { name: b, kind: llm, provider: m, gate: false, include: "tests/deep/*.yaml" }
`,
    "root-only.js": `console.log("SAY: FROM-ROOT");`,
    // the case lives 2 levels down; `node root-only.js` only resolves from the root
    "tests/deep/c.yaml": `cases:\n  - name: r\n    system: "exec:node root-only.js"\n    prompt: hi\n`,
  });
  const config = await loadConfig(path.join(dir, "haechi.yaml"));
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
