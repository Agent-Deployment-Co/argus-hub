import { openaiCompatibleComplete } from "./openai-compatible.ts";
import type { ProviderDescriptor } from "../types.ts";

export const openrouterProvider: ProviderDescriptor = {
  name: "openrouter",
  label: "OpenRouter",
  description: "Connect through OpenRouter to a selected upstream model.",
  requiresApiKey: true,
  configFields: ["model", "effort"],
  complete: (call) => openaiCompatibleComplete(call, {
    baseUrl: "https://openrouter.ai/api/v1",
    tokenParam: "max_tokens",
  }),
};
