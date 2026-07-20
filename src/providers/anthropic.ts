/**
 * Anthropic Messages API adapter.
 */
import type { ChatRequest, ChatResponse, ProviderConfig, ToolCall } from "../types.js";
import { postJson } from "../util.js";
import { requireKey } from "./index.js";

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
      if (req.system) body.system = req.system;
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
      return { text, toolCalls, raw: out };
    },
  };
}
