import { httpComplete } from "../http.ts";
import type { ProviderDescriptor } from "../types.ts";

export const DEFAULT_GEMINI_MODEL = "gemini-3.1-flash-lite";

export const geminiProvider: ProviderDescriptor = {
  name: "gemini",
  label: "Google Gemini",
  description: "Connect to the Google Gemini Generative Language API.",
  defaultModel: DEFAULT_GEMINI_MODEL,
  requiresApiKey: true,
  configFields: ["model", "effort"],
  complete(call) {
    return httpComplete(
      () => ({
        url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(call.model)}:generateContent`,
        init: {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": call.apiKey! },
          body: JSON.stringify({
            ...(call.system ? { systemInstruction: { parts: [{ text: call.system }] } } : {}),
            contents: [{ parts: [{ text: call.prompt }] }],
            generationConfig: {
              maxOutputTokens: call.maxTokens,
              ...(call.effort ? { thinkingConfig: { thinkingLevel: call.effort } } : {}),
            },
          }),
        },
      }),
      (body) => {
        const candidates = (body as { candidates?: unknown } | null)?.candidates;
        const first = Array.isArray(candidates) ? candidates[0] : undefined;
        const parts = (first as { content?: { parts?: unknown } } | undefined)?.content?.parts;
        if (!Array.isArray(parts)) throw new Error("Gemini response had no content parts");
        return parts
          .filter((part): part is { text: string } => typeof (part as { text?: unknown })?.text === "string")
          .map((part) => part.text)
          .join("");
      },
      { fetch: call.fetch, signal: call.signal },
    );
  },
};
