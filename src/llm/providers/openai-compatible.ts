import { httpComplete } from "../http.ts";
import type { LlmResult, ProviderCall } from "../types.ts";

function extractText(body: unknown): string {
  const choices = (body as { choices?: unknown } | null)?.choices;
  const first = Array.isArray(choices) ? choices[0] : undefined;
  const content = (first as { message?: { content?: unknown } } | undefined)?.message?.content;
  if (typeof content !== "string") throw new Error("OpenAI response had no message content");
  return content;
}

export function openaiCompatibleComplete(
  call: ProviderCall,
  options: { baseUrl: string; tokenParam: "max_tokens" | "max_completion_tokens" },
): Promise<LlmResult> {
  return httpComplete(
    () => ({
      url: `${options.baseUrl.replace(/\/+$/, "")}/chat/completions`,
      init: {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${call.apiKey!}` },
        body: JSON.stringify({
          model: call.model,
          [options.tokenParam]: call.maxTokens,
          ...(call.effort ? { reasoning_effort: call.effort } : {}),
          messages: [
            ...(call.system ? [{ role: "system", content: call.system }] : []),
            { role: "user", content: call.prompt },
          ],
        }),
      },
    }),
    extractText,
    { fetch: call.fetch, signal: call.signal },
  );
}
