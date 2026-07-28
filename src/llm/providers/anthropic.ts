import { httpComplete } from "../http.ts";
import type { ProviderCall, ProviderDescriptor } from "../types.ts";

export const DEFAULT_ANTHROPIC_MODEL = "claude-haiku-4-5";

export const claudeApiProvider: ProviderDescriptor = {
  name: "claude-api",
  label: "Anthropic API",
  description: "Connect to Anthropic's Messages API with an organization-managed API key.",
  defaultModel: DEFAULT_ANTHROPIC_MODEL,
  requiresApiKey: true,
  configFields: ["model", "effort"],
  complete(call: ProviderCall) {
    return httpComplete(
      () => ({
        url: "https://api.anthropic.com/v1/messages",
        init: {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": call.apiKey!,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: call.model,
            max_tokens: call.maxTokens,
            ...(call.system ? { system: call.system } : {}),
            ...(call.effort ? { output_config: { effort: call.effort } } : {}),
            messages: [{ role: "user", content: call.prompt }],
          }),
        },
      }),
      (body) => {
        const blocks = (body as { content?: unknown } | null)?.content;
        if (!Array.isArray(blocks)) throw new Error("Anthropic response had no content array");
        return blocks
          .filter((block): block is { type: "text"; text: string } =>
            !!block && typeof block === "object" &&
            (block as { type?: unknown }).type === "text" &&
            typeof (block as { text?: unknown }).text === "string")
          .map((block) => block.text)
          .join("");
      },
      { fetch: call.fetch, signal: call.signal },
    );
  },
};
