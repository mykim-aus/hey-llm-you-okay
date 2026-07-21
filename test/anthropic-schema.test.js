/**
 * Anthropic responseSchema — the Messages API has no responseSchema, so heyllm
 * emulates it with a single FORCED tool whose input_schema is the schema, and
 * surfaces the tool input as JSON text. Verified against a tiny mock endpoint.
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createProviders } from "../dist/index.js";

let server, base, lastBody;
test.before(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      lastBody = JSON.parse(body || "{}");
      res.writeHead(200, { "content-type": "application/json" });
      // respond as if the model "called" the forced tool with structured input
      res.end(JSON.stringify({
        content: [{ type: "tool_use", id: "t1", name: "emit_json", input: { intent: "refund", urgent: true } }],
        usage: { input_tokens: 10, output_tokens: 5 },
      }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => new Promise((r) => server.close(r)));

test("responseSchema → forced emit_json tool; input surfaced as JSON text", async () => {
  process.env.ANTHROPIC_TEST_KEY = "k";
  const providers = createProviders({
    m: { kind: "anthropic", baseUrl: base, model: "claude-x", apiKeyEnv: "ANTHROPIC_TEST_KEY" },
  });
  const res = await providers.m.chat({
    messages: [{ role: "user", content: "I want a refund now" }],
    responseSchema: { type: "object", properties: { intent: { type: "string" }, urgent: { type: "boolean" } }, required: ["intent"] },
  });
  // request forced the schema tool
  assert.equal(lastBody.tool_choice?.name, "emit_json");
  assert.equal(lastBody.tools?.[0]?.name, "emit_json");
  assert.equal(lastBody.tools?.[0]?.input_schema?.required?.[0], "intent");
  // response: structured answer as JSON text, and NOT exposed as a tool call
  assert.deepEqual(JSON.parse(res.text), { intent: "refund", urgent: true });
  assert.equal(res.toolCalls.length, 0, "the emulation tool is not surfaced as an app tool call");
});
