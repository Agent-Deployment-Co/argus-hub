import { claudeApiProvider } from "./providers/anthropic.ts";
import { commandProvider } from "./providers/command.ts";
import { geminiProvider } from "./providers/gemini.ts";
import { openaiProvider } from "./providers/openai.ts";
import { openrouterProvider } from "./providers/openrouter.ts";
import type { LlmConfigField, LlmProvider, ProviderDescriptor } from "./types.ts";

export const PROVIDERS: readonly ProviderDescriptor[] = [
  claudeApiProvider,
  commandProvider,
  geminiProvider,
  openaiProvider,
  openrouterProvider,
];

const BY_NAME = new Map<string, ProviderDescriptor>(PROVIDERS.map((provider) => [provider.name, provider]));

export const LLM_PROVIDERS: readonly LlmProvider[] = PROVIDERS.map((provider) => provider.name);
export const SELECTABLE_PROVIDERS = LLM_PROVIDERS;

export function getProvider(name: string): ProviderDescriptor | undefined {
  return BY_NAME.get(name);
}

export function isLlmProvider(value: string): value is LlmProvider {
  return BY_NAME.has(value);
}

export function providersForConfigField(field: LlmConfigField): readonly LlmProvider[] {
  return PROVIDERS.filter((provider) => provider.configFields.includes(field)).map((provider) => provider.name);
}

export function defaultModelByProvider(): Record<string, string> {
  return Object.fromEntries(PROVIDERS.flatMap((provider) =>
    provider.defaultModel ? [[provider.name, provider.defaultModel]] : []));
}
