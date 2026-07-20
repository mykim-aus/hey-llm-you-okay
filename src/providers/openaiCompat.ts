/**
 * OpenAI-compatible /chat/completions adapter.
 * Covers OpenAI, Ollama (http://localhost:11434/v1), LM Studio, vLLM, Groq…
 * `apiKeyEnv` is optional — local servers usually need none.
 */
import type { ChatRequest, ChatResponse, ProviderConfig, ToolCall } from "../types.js";
import { postJson } from "../util.js";
import { requireKey } from "./index.js";

const safeParse = (s: unknown): Record<string, unknown> => {
  try {
    return JSON.parse(String(s ?? "{}"));
  } catch {
    return { _raw: s };
  }
};

export function openaiCompat(cfg: ProviderConfig, name: string) {
  const base = (cfg.baseUrl || "https://api.openai.com/v1").replace(/\/$/, "");
  return {
    async chat(req: ChatRequest): Promise<ChatResponse> {
      if (!cfg.baseUrl) requireKey(cfg, name); // hosted default needs a key; local baseUrl may not
      const messages: any[] = [];
      if (req.system) messages.push({ role: "system", content: req.system });
      for (const m of req.messages || []) {
        if (m.role === "tool") {
          for (const r of m.toolResults || [])
            messages.push({
              role: "tool",
              tool_call_id: r.id || r.name,
              content: JSON.stringify(r.response ?? {}),
            });
        } else if (m.role === "assistant" && m.toolCalls?.length) {
          messages.push({
            role: "assistant",
            content: m.content || null,
            tool_calls: m.toolCalls.map((tc) => ({
              id: tc.id || tc.name,
              type: "function",
              function: { name: tc.name, arguments: JSON.stringify(tc.args || {}) },
            })),
          });
        } else {
          messages.push({ role: m.role, content: m.content ?? "" });
        }
      }
      const body: any = { model: cfg.model, messages };
      if (req.tools?.length)
        body.tools = req.tools.map((t) => ({
          type: "function",
          function: { name: t.name, description: t.description, parameters: t.parameters },
        }));
      if (req.temperature !== undefined) body.temperature = req.temperature;
      if (req.maxTokens) body.max_tokens = req.maxTokens;
      if (req.json) body.response_format = { type: "json_object" };

      const headers: Record<string, string> = {};
      if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
      const out = await postJson(`${base}/chat/completions`, {
        headers,
        body,
        timeoutMs: cfg.timeoutMs ?? 60000,
        retries: cfg.retries ?? 1,
      });
      const msg = out.choices?.[0]?.message ?? {};
      const toolCalls: ToolCall[] = (msg.tool_calls || []).map((tc: any) => ({
        id: tc.id,
        name: tc.function?.name,
        args: safeParse(tc.function?.arguments),
      }));
      return { text: msg.content || "", toolCalls, raw: out };
    },
  };
}
