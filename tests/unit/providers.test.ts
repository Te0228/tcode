import { describe, expect, it } from "vitest";
import {
  MissingApiKeyError,
  UnknownProviderError,
  resolveProviderConfig,
} from "../../src/llm/providers.js";

describe("resolveProviderConfig", () => {
  it("defaults to anthropic and only requires ANTHROPIC_API_KEY", () => {
    const config = resolveProviderConfig({ ANTHROPIC_API_KEY: "sk-ant-1" });
    expect(config).toEqual({
      provider: "anthropic",
      adapter: "anthropic",
      apiKey: "sk-ant-1",
      model: "claude-sonnet-5",
      baseUrl: undefined,
      contextWindowTokens: 200_000,
    });
  });

  it("does not require DEEPSEEK_* vars when PROVIDER=anthropic", () => {
    expect(() =>
      resolveProviderConfig({ PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-ant-1" }),
    ).not.toThrow();
  });

  it("does not require ANTHROPIC_* vars when PROVIDER=deepseek", () => {
    const config = resolveProviderConfig({ PROVIDER: "deepseek", DEEPSEEK_API_KEY: "sk-ds-1" });
    expect(config).toEqual({
      provider: "deepseek",
      adapter: "openai-compat",
      apiKey: "sk-ds-1",
      model: "deepseek-chat",
      baseUrl: "https://api.deepseek.com",
      contextWindowTokens: 65_536,
    });
  });

  it("prefers explicit model/base_url env vars over defaults", () => {
    const config = resolveProviderConfig({
      PROVIDER: "deepseek",
      DEEPSEEK_API_KEY: "sk-ds-1",
      DEEPSEEK_MODEL: "deepseek-reasoner",
      DEEPSEEK_BASE_URL: "https://gateway.internal",
    });
    expect(config.model).toBe("deepseek-reasoner");
    expect(config.baseUrl).toBe("https://gateway.internal");
  });

  it("takes the provider's context window by default and lets env override it", () => {
    expect(resolveProviderConfig({ DEEPSEEK_API_KEY: "k", PROVIDER: "deepseek" }).contextWindowTokens).toBe(65_536);
    expect(
      resolveProviderConfig({ DEEPSEEK_API_KEY: "k", PROVIDER: "deepseek", CONTEXT_WINDOW_TOKENS: "12000" })
        .contextWindowTokens,
    ).toBe(12_000);
    // Invalid values fall back rather than blocking startup.
    expect(
      resolveProviderConfig({ DEEPSEEK_API_KEY: "k", PROVIDER: "deepseek", CONTEXT_WINDOW_TOKENS: "0" })
        .contextWindowTokens,
    ).toBe(65_536);
  });

  it("throws MissingApiKeyError when the active provider's key is absent", () => {
    expect(() => resolveProviderConfig({ PROVIDER: "deepseek" })).toThrow(MissingApiKeyError);
  });

  it("throws UnknownProviderError for an unregistered provider name", () => {
    expect(() => resolveProviderConfig({ PROVIDER: "moonshot" })).toThrow(UnknownProviderError);
  });
});
