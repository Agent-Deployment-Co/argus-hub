import type { SecretCipher } from "../secrets.ts";
import type { HubStore } from "../store/hub-store.ts";
import { getProvider } from "./registry.ts";
import type { ResolvedLlmConfig } from "./types.ts";

export class LlmConfigurationError extends Error {
  constructor(message: string, readonly status: 400 | 500 | 503 = 400) {
    super(message);
    this.name = "LlmConfigurationError";
  }
}

export async function resolveTaskLlmConfig(
  store: HubStore,
  orgId: string,
  secretCipher?: SecretCipher,
): Promise<ResolvedLlmConfig> {
  const settings = await store.readTaskLlmSettings(orgId);
  if (!settings.provider) {
    throw new LlmConfigurationError("Choose and save an LLM provider first.");
  }
  const provider = getProvider(settings.provider);
  if (!provider) throw new LlmConfigurationError("The configured LLM provider is invalid.");
  const config = settings.providerConfigs[settings.provider] ?? {};
  if (settings.provider === "command" && !config.command?.trim()) {
    throw new LlmConfigurationError("Save a non-empty custom command first.");
  }
  let apiKey: string | undefined;
  if (provider.requiresApiKey) {
    if (!secretCipher) throw new LlmConfigurationError("Secret encryption is unavailable.", 503);
    const encrypted = await store.readEncryptedLlmSecret(orgId, settings.provider);
    if (!encrypted) throw new LlmConfigurationError("Add an API key for the saved provider first.");
    try {
      apiKey = secretCipher.decrypt(orgId, settings.provider, encrypted);
    } catch {
      throw new LlmConfigurationError(
        "The stored API key cannot be decrypted. Check HUB_SECRET_KEY and replace the API key.",
        500,
      );
    }
  }
  return { provider: settings.provider, ...config, apiKey };
}

export function sanitizeLlmError(
  error: string | undefined,
  status: number | null | undefined,
  provider: string,
  apiKey?: string,
): string {
  if (status === 401 || status === 403) return "Authentication failed. Check the configured API key.";
  if (/abort|timeout/i.test(error ?? "")) return "The provider request timed out.";
  if (/no model|invalid config/i.test(error ?? "")) return "The provider configuration is incomplete or invalid.";
  if (provider === "command") return "The configured command failed. Check the command on the Hub host.";
  let safe = (error ?? "Provider request failed.").replaceAll(apiKey ?? "\0", "[redacted]");
  safe = safe.replace(/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, "$1");
  safe = safe.replace(/([?&#][^\s]*)/g, "");
  safe = safe.replace(/(authorization|x-api-key)\s*[:=]\s*[^\s,;]+/gi, "$1: [redacted]");
  return safe.slice(0, 300) || "Provider request failed.";
}
