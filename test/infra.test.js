/**
 * Regressions for the "silently unverified" family of bugs (0.1.4).
 *
 * Every case here is the same shape: heyllm accepted something, could not
 * actually honour it, and reported a result anyway. The assertions are about
 * how the failure SURFACES, not just that a boolean flipped — a green run that
 * verified nothing is the exact failure mode this tool exists to catch, so the
 * tool must not commit it itself.
 */
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { loadConfig } from "../dist/config.js";
import { runSuite } from "../dist/runner.js";
import { command } from "../dist/providers/command.js";
import { anthropic } from "../dist/providers/anthropic.js";
import { ProviderError, callProvider } from "../dist/util.js";

async function project(files) {
  const dir = await mkdtemp(path.join(tmpdir(), "heyllm-infra-"));
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(dir, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, body);
  }
  return dir;
}

/**
 * A real, closed port: bind one, read the number the OS assigned, then release
 * it. Picking a constant risks colliding with something the developer is
 * running, and the low reserved ports (9, 1) are rejected by Node as "bad port"
 * before a connection is ever attempted — which tests the wrong code path.
 */
async function closedPort() {
  const { createServer } = await import("node:net");
  return await new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}
const DEAD = `http://127.0.0.1:${await closedPort()}/v1`;

test("unreachable provider does not pass a warn-only layer", async () => {
  const dir = await project({
    "heyllm.yaml": `
providers:
  subject: { kind: openai-compatible, baseUrl: "${DEAD}", model: m, apiKeyEnv: FAKE_KEY }
layers:
  - name: behavior
    kind: llm
    provider: subject
    gate: false
    cases:
      - { name: greets, prompt: hi, expect: { text: hi } }
`,
  });
  process.env.FAKE_KEY = "x";
  const config = await loadConfig(path.join(dir, "heyllm.yaml"));
  const summary = await runSuite(config);

  // Before 0.1.4 this reported PASS with exit 0: the layer was non-gated, so a
  // provider that never answered was absorbed as an ordinary soft failure.
  assert.equal(summary.ok, false, "an unreachable provider must not report PASS");
  assert.ok(summary.infra?.length, "the fault must be recorded as infrastructure");
  assert.equal(summary.infra[0].layer, "behavior");
  assert.equal(summary.infra[0].case, "greets");
});

test("connection-refused message names the host and the likely cause", async () => {
  const dir = await project({
    "heyllm.yaml": `
providers:
  subject: { kind: openai-compatible, baseUrl: "${DEAD}", model: m, apiKeyEnv: FAKE_KEY }
layers:
  - name: behavior
    kind: llm
    provider: subject
    cases:
      - { name: greets, prompt: hi, expect: { text: hi } }
`,
  });
  process.env.FAKE_KEY = "x";
  const summary = await runSuite(await loadConfig(path.join(dir, "heyllm.yaml")));
  const msg = summary.infra[0].message;
  // "fetch failed" on its own sent people hunting through their YAML.
  assert.ok(msg.includes(new URL(DEAD).origin), "must name the host that refused");
  assert.match(msg, /connection refused|is the server running/i);
  assert.doesNotMatch(msg, /^fetch failed$/);
});

test("a layer whose provider only a profile defines fails loudly, not silently", async () => {
  const dir = await project({
    "heyllm.yaml": `
providers:
  judge: { kind: command, command: echo, outputPath: null }
profiles:
  live:
    providers:
      subject: { kind: anthropic, model: claude-sonnet-5, apiKeyEnv: FAKE_KEY }
layers:
  - name: routing
    kind: llm
    provider: subject
    gate: false
    cases:
      - { name: routes, prompt: hi, expect: { text: hi } }
`,
  });
  // Validation accepts the profile-only reference…
  const config = await loadConfig(path.join(dir, "heyllm.yaml"));
  assert.ok(config, "config with a profile-only provider must parse");

  // …and running without that profile is an infra fault, not a quiet skip.
  const summary = await runSuite(config);
  assert.equal(summary.ok, false);
  assert.ok(summary.infra?.length);
  assert.match(summary.infra[0].message, /profile/i);
});

test("command provider refuses tool calls by name instead of returning none", async () => {
  const p = command({ kind: "command", command: "echo" }, "my-cli");
  await assert.rejects(
    () =>
      p.chat({
        messages: [{ role: "user", content: "weather?" }],
        tools: [{ name: "get_weather", description: "w", parameters: {} }],
      }),
    (e) => {
      assert.ok(e instanceof ProviderError, "must be an infrastructure fault");
      assert.match(e.message, /my-cli/, "must name the offending provider");
      assert.match(e.message, /get_weather/, "must name the tool that cannot work");
      return true;
    },
    "declaring tools against a CLI provider must fail, not report zero tool calls"
  );
});

test("anthropic honours json:true — instruction sent and fence stripped", async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push(JSON.parse(init.body));
    return new Response(
      JSON.stringify({ content: [{ type: "text", text: '```json\n{"status":"ok"}\n```' }] }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };
  try {
    const p = anthropic({ kind: "anthropic", model: "claude-sonnet-5", apiKey: "x" }, "claude");
    const res = await p.chat({ messages: [{ role: "user", content: "give me json" }], json: true });
    // The Messages API has no response_format, so the contract is carried by a
    // system instruction plus unwrapping on the way back.
    assert.match(calls[0].system, /JSON/i, "json:true must reach the model as an instruction");
    assert.equal(res.text, '{"status":"ok"}', "a fenced reply must be unwrapped");
    JSON.parse(res.text); // the whole point: downstream jsonPath can parse it
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("anthropic leaves json alone when the case declares tools", async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ content: [{ type: "text", text: "hi" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const p = anthropic({ kind: "anthropic", model: "claude-sonnet-5", apiKey: "x" }, "claude");
    await p.chat({
      messages: [{ role: "user", content: "weather?" }],
      json: true,
      tools: [{ name: "get_weather", description: "w", parameters: {} }],
    });
    // A tool-use turn legitimately returns no text; forcing raw JSON there
    // would fight the tool protocol.
    assert.ok(!/JSON/i.test(calls[0].system || ""), "must not force JSON on a tool turn");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("callProvider tags foreign errors but preserves ProviderError", async () => {
  await assert.rejects(
    () => callProvider("p", async () => { throw new Error("boom"); }),
    (e) => e instanceof ProviderError && e.message === "boom" && e.providerName === "p"
  );
  const original = new ProviderError("already tagged", "orig");
  await assert.rejects(
    () => callProvider("p", async () => { throw original; }),
    (e) => e === original, "an existing ProviderError must pass through unchanged"
  );
});
