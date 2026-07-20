/**
 * Google Gemini generateContent adapter (v1beta) incl. function calling.
 * Tool `parameters` pass through verbatim — supply Gemini-flavored schemas
 * (uppercase TYPE enums) when targeting Gemini.
 */
import type { ChatRequest, ChatResponse, ProviderConfig, ToolCall } from "../types.js";
import { postJson } from "../util.js";
import { requireKey } from "./index.js";

export function gemini(cfg: ProviderConfig, name: string) {
  const base = (cfg.baseUrl || "https://generativelanguage.googleapis.com/v1beta").replace(/\/$/, "");
  return {
    async chat(req: ChatRequest): Promise<ChatResponse> {
      requireKey(cfg, name);
      const contents: any[] = [];
      for (const m of req.messages || []) {
        if (m.role === "tool") {
          contents.push({
            role: "user",
            parts: (m.toolResults || []).map((r) => ({
              functionResponse: { name: r.name, response: r.response ?? {} },
            })),
          });
        } else if (m.role === "assistant") {
          const parts: any[] = [];
          if (m.content) parts.push({ text: m.content });
          for (const tc of m.toolCalls || [])
            parts.push({ functionCall: { name: tc.name, args: tc.args || {} } });
          if (parts.length) contents.push({ role: "model", parts });
        } else {
          contents.push({ role: "user", parts: [{ text: m.content ?? "" }] });
        }
      }
      const body: any = { contents };
      if (req.system) body.systemInstruction = { parts: [{ text: req.system }] };
      if (req.tools?.length) body.tools = [{ functionDeclarations: req.tools }];
      const gen: any = { ...(cfg.generationConfig || {}) }; // e.g. thinkingConfig passthrough
      if (req.temperature !== undefined) gen.temperature = req.temperature;
      if (req.maxTokens) gen.maxOutputTokens = req.maxTokens;
      if (req.json) gen.responseMimeType = "application/json";
      if (Object.keys(gen).length) body.generationConfig = gen;

      const out = await postJson(`${base}/models/${cfg.model}:generateContent`, {
        headers: { "x-goog-api-key": cfg.apiKey || "" },
        body,
        timeoutMs: cfg.timeoutMs ?? 60000,
        retries: cfg.retries ?? 1,
      });
      const parts = out.candidates?.[0]?.content?.parts || [];
      let text = "";
      const toolCalls: ToolCall[] = [];
      for (const p of parts) {
        if (p.text) text += p.text;
        if (p.functionCall)
          toolCalls.push({ id: p.functionCall.id, name: p.functionCall.name, args: p.functionCall.args || {} });
      }
      return { text, toolCalls, raw: out };
    },
  };
}
