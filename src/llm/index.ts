import { getProvider } from "./registry.ts";
import type { LlmRequest, LlmResult, ResolvedLlmConfig } from "./types.ts";

export * from "./registry.ts";
export type * from "./types.ts";

export const DEFAULT_MAX_TOKENS = 64;

export interface LlmClientDeps {
  fetch?: typeof fetch;
  executeCommand?: import("./types.ts").ExecuteCommand;
}

export async function complete(
  request: LlmRequest,
  config: ResolvedLlmConfig,
  deps: LlmClientDeps = {},
): Promise<LlmResult> {
  const provider = getProvider(config.provider);
  if (!provider) return { ok: false, text: "", error: `Unknown LLM provider "${config.provider}".` };
  if (provider.requiresApiKey && !config.apiKey) {
    return { ok: false, text: "", error: `No API key is configured for the ${config.provider} provider.` };
  }
  const model = request.model ?? config.model ?? provider.defaultModel ?? "";
  if (provider.configFields.includes("model") && !model) {
    return { ok: false, text: "", error: `No model is configured for the ${config.provider} provider.` };
  }
  try {
    return await provider.complete({
      system: request.system,
      prompt: request.prompt,
      model,
      maxTokens: request.maxTokens || DEFAULT_MAX_TOKENS,
      effort: request.effort || config.effort || undefined,
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      command: config.command,
      fetch: deps.fetch ?? fetch,
      executeCommand: deps.executeCommand,
      signal: request.signal,
    });
  } catch (error) {
    return {
      ok: false,
      text: "",
      error: error instanceof Error ? error.message : "provider execution failed",
    };
  }
}
