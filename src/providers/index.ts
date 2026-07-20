/**
 * Provider registry. Every provider implements Provider.chat(ChatRequest) →
 * ChatResponse with normalized tool calls, so layers and the triage engine are
 * provider-agnostic. Keys come from env via `apiKeyEnv` and are checked at
 * CALL time — offline layers and `heyllm validate` never require them.
 */
import type { Provider, ProviderConfig } from "../types.js";
import { openaiCompat } from "./openaiCompat.js";
import { anthropic } from "./anthropic.js";
import { gemini } from "./gemini.js";
import { command } from "./command.js";

type Factory = (cfg: ProviderConfig, name: string) => Pick<Provider, "chat">;

const KINDS: Record<string, Factory> = {
  "openai-compatible": openaiCompat,
  anthropic,
  gemini,
  command,
};

export function createProviders(providerConfigs: Record<string, ProviderConfig>): Record<string, Provider> {
  const out: Record<string, Provider> = {};
  for (const [name, cfg] of Object.entries(providerConfigs || {})) {
    const make = KINDS[cfg.kind];
    if (!make) throw new Error(`unknown provider kind '${cfg.kind}' for provider '${name}'`);
    const resolved: ProviderConfig = {
      ...cfg,
      apiKey: cfg.apiKeyEnv ? process.env[cfg.apiKeyEnv] : cfg.apiKey,
    };
    out[name] = {
      name,
      kind: cfg.kind,
      model: cfg.model ?? cfg.command,
      ...make(resolved, name),
    };
  }
  return out;
}

export function requireKey(cfg: ProviderConfig, name: string): void {
  if (cfg.apiKeyEnv && !cfg.apiKey)
    throw new Error(`provider '${name}': env ${cfg.apiKeyEnv} is not set (required for kind '${cfg.kind}')`);
}
