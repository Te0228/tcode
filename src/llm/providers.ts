/**
 * Provider registry (spec §8.1/§8.2): maps a provider name to which
 * adapter it speaks and which env vars carry its key/model/base_url.
 * Adding a new OpenAI-compatible provider only means adding a row here.
 */

export type AdapterName = "anthropic" | "openai-compat";

export interface ProviderDefinition {
  adapter: AdapterName;
  apiKeyEnv: string;
  modelEnv: string;
  baseUrlEnv: string;
  modelDefault: string;
  baseUrlDefault?: string;
  /** Context window in tokens. A provider property, not a global default:
   * the sizes differ enough that one value would either waste context or
   * overrun it (spec §8.1/§8.2). */
  contextWindowDefault: number;
}

export const PROVIDERS: Record<string, ProviderDefinition> = {
  anthropic: {
    adapter: "anthropic",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    modelEnv: "ANTHROPIC_MODEL",
    baseUrlEnv: "ANTHROPIC_BASE_URL",
    modelDefault: "claude-sonnet-5",
    contextWindowDefault: 200_000,
  },
  deepseek: {
    adapter: "openai-compat",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    modelEnv: "DEEPSEEK_MODEL",
    baseUrlEnv: "DEEPSEEK_BASE_URL",
    modelDefault: "deepseek-chat",
    baseUrlDefault: "https://api.deepseek.com",
    contextWindowDefault: 65_536,
  },
};

export interface ResolvedProviderConfig {
  provider: string;
  adapter: AdapterName;
  apiKey: string;
  model: string;
  baseUrl?: string;
  contextWindowTokens: number;
}

export class MissingApiKeyError extends Error {
  constructor(
    public readonly provider: string,
    public readonly envVar: string,
  ) {
    super(`missing ${envVar} for PROVIDER=${provider}`);
    this.name = "MissingApiKeyError";
  }
}

export class UnknownProviderError extends Error {
  constructor(public readonly provider: string) {
    super(`unknown PROVIDER "${provider}" (known: ${Object.keys(PROVIDERS).join(", ")})`);
    this.name = "UnknownProviderError";
  }
}

function positiveIntEnv(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return raw !== undefined && Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

/**
 * Resolves the active provider's config from env (spec §8.2). Only reads
 * the env vars for the selected provider — other providers' missing keys
 * never block startup. Throws on unknown provider or missing api key so
 * the caller can fail fast before entering the REPL.
 */
export function resolveProviderConfig(
  env: NodeJS.ProcessEnv = process.env,
): ResolvedProviderConfig {
  const provider = env.PROVIDER?.trim() || "anthropic";
  const definition = PROVIDERS[provider];
  if (!definition) {
    throw new UnknownProviderError(provider);
  }

  const apiKey = env[definition.apiKeyEnv];
  if (!apiKey) {
    throw new MissingApiKeyError(provider, definition.apiKeyEnv);
  }

  return {
    provider,
    adapter: definition.adapter,
    apiKey,
    model: env[definition.modelEnv] || definition.modelDefault,
    baseUrl: env[definition.baseUrlEnv] || definition.baseUrlDefault,
    contextWindowTokens: positiveIntEnv(
      env.CONTEXT_WINDOW_TOKENS,
      definition.contextWindowDefault,
    ),
  };
}
