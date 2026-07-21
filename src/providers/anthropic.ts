/**
 * Anthropic Messages API adapter.
 */
import type { ChatRequest, ChatResponse, ProviderConfig, TokenUsage, ToolCall } from "../types.js";

// Anthropic shape: {input_tokens, output_tokens, cache_read_input_tokens?,
// cache_creation_input_tokens?}. input_tokens EXCLUDES the cache fields; heyllm
// never sends cache_control so they are normally absent. We do not fold them
// in — they bill at different multipliers and folding would corrupt any later
// cost math. total is reconstructed since the API does not send one.
function readUsage(u: any): TokenUsage | undefined {
  if (!u || typeof u !== "object") return undefined;
  const input = u.input_tokens,
    output = u.output_tokens;
  if (input === undefined && output === undefined) return undefined;
  return {
    ...(input !== undefined ? { inputTokens: input } : {}),
    ...(output !== undefined ? { outputTokens: output } : {}),
    totalTokens: (input ?? 0) + (output ?? 0),
  };
}
import { postJson } from "../util.js";
import { requireKey } from "./index.js";

/** Unwrap a ```json … ``` (or bare ```) fence when the whole reply is one block. */
function stripJsonFence(text: string): string {
  const m = text.trim().match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/i);
  return m ? m[1].trim() : text;
}

export function anthropic(cfg: ProviderConfig, name: string) {
  const base = (cfg.baseUrl || "https://api.anthropic.com").replace(/\/$/, "");
  return {
    async chat(req: ChatRequest): Promise<ChatResponse> {
      requireKey(cfg, name);
      const messages: any[] = [];
      for (const m of req.messages || []) {
        if (m.role === "tool") {
          messages.push({
            role: "user",
            content: (m.toolResults || []).map((r) => ({
              type: "tool_result",
              tool_use_id: r.id || r.name,
              content: JSON.stringify(r.response ?? {}),
            })),
          });
        } else if (m.role === "assistant" && m.toolCalls?.length) {
          const content: any[] = [];
          if (m.content) content.push({ type: "text", text: m.content });
          for (const tc of m.toolCalls)
            content.push({ type: "tool_use", id: tc.id || tc.name, name: tc.name, input: tc.args || {} });
          messages.push({ role: "assistant", content });
        } else {
          messages.push({ role: m.role, content: m.content ?? "" });
        }
      }
      const body: any = {
        model: cfg.model,
        max_tokens: req.maxTokens ?? cfg.maxTokens ?? 2048,
        messages,
      };
      // The Messages API has no `response_format`, so `json: true` is honoured
      // by instruction plus fence-stripping on the way out. Without this the
      // flag was accepted, threaded through the layer, and silently dropped
      // here — the caller then got a fenced ```json block that `jsonPath`
      // could not parse, which reads as a model failure rather than an
      // unsupported option. Skipped when tools are in play: a tool-use turn
      // legitimately returns no text at all.
      // Structured output: the Messages API has no responseSchema, so we emulate
      // it with a single forced tool whose input_schema IS the schema — the model
      // must "call" it, and its input is the structured answer (surfaced as JSON
      // text, so json/jsonPath assertions behave the same as on gemini/openai).
      // Skipped when the case already uses functional tools (can't force both).
      const wantsSchema = !!req.responseSchema && !req.tools?.length;
      const wantsJson = !!req.json && !req.tools?.length && !wantsSchema;
      const jsonRule =
        "Respond with a single raw JSON value and nothing else. " +
        "No prose, no explanation, and no markdown code fences.";
      if (req.system || wantsJson)
        body.system = [req.system, wantsJson ? jsonRule : null].filter(Boolean).join("\n\n");
      // Newer Claude models removed sampling params — sending them is a 400.
      const omitTemp =
        cfg.omitTemperature ?? /^claude-(opus-4-[78]|sonnet-5|fable-5)/.test(cfg.model ?? "");
      if (req.temperature !== undefined && req.temperature !== null && !omitTemp)
        body.temperature = req.temperature;
      if (req.tools?.length)
        body.tools = req.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.parameters || { type: "object", properties: {} },
        }));
      if (wantsSchema) {
        body.tools = [
          { name: "emit_json", description: "Return the answer as a single JSON value matching the schema.", input_schema: req.responseSchema },
        ];
        body.tool_choice = { type: "tool", name: "emit_json" };
      }

      const out = await postJson(`${base}/v1/messages`, {
        headers: {
          "x-api-key": cfg.apiKey || "",
          "anthropic-version": cfg.apiVersion || "2023-06-01",
        },
        body,
        timeoutMs: cfg.timeoutMs ?? 60000,
        retries: cfg.retries ?? 1,
      });
      let text = "";
      const toolCalls: ToolCall[] = [];
      for (const block of out.content || []) {
        if (block.type === "text") text += block.text;
        else if (block.type === "tool_use")
          toolCalls.push({ id: block.id, name: block.name, args: block.input || {} });
      }
      // The forced emit_json tool call's input IS the structured answer — surface
      // it as JSON text and drop the tool call (an emulation artifact, not a tool
      // the app decided to call).
      if (wantsSchema) {
        const emit = toolCalls.find((tc) => tc.name === "emit_json");
        if (emit) {
          text = JSON.stringify(emit.args);
          toolCalls.length = 0;
        }
      }
      // Models still fence JSON often enough that instruction alone is not a
      // contract. Unwrapping here means `json: true` behaves the same on every
      // provider, which is the only reason the option is worth having.
      if (wantsJson) text = stripJsonFence(text);
      return { text, toolCalls, raw: out, usage: readUsage(out.usage) };
    },
  };
}
