/**
 * Resolves the active provider once (spec §8.1: no runtime provider
 * switching) and returns its `send()` function. Callers (agent.ts) never
 * see provider names or wire formats past this point.
 */
import { createAnthropicSend } from "./adapters/anthropic.js";
import { createOpenAICompatSend } from "./adapters/openai-compat.js";
import { resolveProviderConfig, type ResolvedProviderConfig } from "./providers.js";
import type { SendFn } from "./types.js";

export { resolveProviderConfig, PROVIDERS, MissingApiKeyError, UnknownProviderError } from "./providers.js";
export type { ResolvedProviderConfig } from "./providers.js";
export * from "./types.js";

export function createSend(config: ResolvedProviderConfig): SendFn {
  switch (config.adapter) {
    case "anthropic":
      return createAnthropicSend({ apiKey: config.apiKey, model: config.model, baseUrl: config.baseUrl });
    case "openai-compat":
      return createOpenAICompatSend({ apiKey: config.apiKey, model: config.model, baseUrl: config.baseUrl });
  }
}

/** Convenience: resolve from env and build `send()` in one call. */
export function createSendFromEnv(env: NodeJS.ProcessEnv = process.env): {
  config: ResolvedProviderConfig;
  send: SendFn;
} {
  const config = resolveProviderConfig(env);
  return { config, send: createSend(config) };
}
