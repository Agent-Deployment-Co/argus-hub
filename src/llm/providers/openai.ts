import { openaiCompatibleComplete } from "./openai-compatible.ts";
import type { ProviderDescriptor } from "../types.ts";

export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_OPENAI_MODEL = "gpt-5.4-nano";

export const openaiProvider: ProviderDescriptor = {
  name: "openai",
  label: "OpenAI",
  description: "Connect to OpenAI or an OpenAI-compatible endpoint.",
  defaultModel: DEFAULT_OPENAI_MODEL,
  requiresApiKey: true,
  configFields: ["model", "baseUrl", "effort"],
  complete: (call) => openaiCompatibleComplete(call, {
    baseUrl: call.baseUrl || DEFAULT_OPENAI_BASE_URL,
    tokenParam: "max_completion_tokens",
  }),
};
