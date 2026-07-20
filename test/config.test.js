import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig, ConfigError } from "../dist/index.js";

async function scaffold(configYaml, files = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "haechi-"));
  await writeFile(path.join(dir, "haechi.yaml"), configYaml);
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, content);
  }
  return dir;
}

test("valid config loads with gate defaults (static=true, llm=false)", async () => {
  const dir = await scaffold(`
version: 1
providers:
  m: { kind: openai-compatible, baseUrl: http://x, model: m1 }
layers:
  - { name: s, kind: static, cases: [{ name: a, file: haechi.yaml }] }
  - { name: b, kind: llm, provider: m, cases: [{ name: c, prompt: hi }] }
`);
  const cfg = await loadConfig(path.join(dir, "haechi.yaml"));
  assert.equal(cfg.layers[0].gate, true);
  assert.equal(cfg.layers[1].gate, false);
});

test("unknown layer kind / missing provider ref / raw apiKey are rejected", async () => {
  for (const yaml of [
    `layers: [{ name: a, kind: judg, cases: [] }]`,
    `providers: {}\nlayers: [{ name: a, kind: llm, provider: nope, cases: [{name: x, prompt: hi}] }]`,
    `providers: { m: { kind: gemini, model: g, apiKey: sk-123 } }\nlayers: [{ name: a, kind: llm, provider: m, cases: [{name: x, prompt: hi}] }]`,
  ]) {
    const dir = await scaffold(yaml);
    await assert.rejects(() => loadConfig(path.join(dir, "haechi.yaml")), ConfigError);
  }
});

test("profiles overlay providers (--profile / HAECHI_PROFILE)", async () => {
  const dir = await scaffold(`
providers:
  m: { kind: openai-compatible, baseUrl: http://local, model: llama }
profiles:
  ci:
    providers:
      m: { kind: gemini, model: gemini-2.5-flash, apiKeyEnv: GEMINI_API_KEY }
layers:
  - { name: b, kind: llm, provider: m, cases: [{ name: c, prompt: hi }] }
`);
  const local = await loadConfig(path.join(dir, "haechi.yaml"));
  assert.equal(local.providers.m.kind, "openai-compatible");
  const ci = await loadConfig(path.join(dir, "haechi.yaml"), { profile: "ci" });
  assert.equal(ci.providers.m.kind, "gemini");
  assert.equal(ci.profile, "ci");
  await assert.rejects(() => loadConfig(path.join(dir, "haechi.yaml"), { profile: "nope" }), ConfigError);
});

test("duplicate case names within a layer are rejected (triage/baseline keys)", async () => {
  const dir = await scaffold(
    `
providers: {}
layers:
  - { name: s, kind: static, include: "tests/*.yaml" }
`,
    {
      "tests/a.yaml": `cases: [{ name: dup, file: haechi.yaml }]`,
      "tests/b.yaml": `cases: [{ name: dup, file: haechi.yaml }]`,
    }
  );
  const cfg = await loadConfig(path.join(dir, "haechi.yaml"));
  const { loadLayerCases } = await import("../dist/index.js");
  await assert.rejects(() => loadLayerCases(cfg.layers[0], cfg.baseDir), /duplicate case name/);
});
