import type { LlmResult } from "./types.ts";

export const MAX_LLM_RESPONSE_BYTES = 32 * 1024 * 1024;

export interface HttpAttempt {
  url: string;
  init: RequestInit;
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

async function readCappedText(res: Response): Promise<string | undefined> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_LLM_RESPONSE_BYTES) return undefined;
  if (!res.body) {
    const text = await res.text();
    return Buffer.byteLength(text, "utf8") <= MAX_LLM_RESPONSE_BYTES ? text : undefined;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_LLM_RESPONSE_BYTES) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

function describeHttpError(status: number, text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return `HTTP ${status}`;
  try {
    const body = JSON.parse(trimmed) as { error?: { message?: unknown }; message?: unknown };
    const message = body.error?.message ?? body.message;
    if (typeof message === "string" && message) return `HTTP ${status}: ${message}`;
  } catch {
    // Use a bounded raw diagnostic for non-JSON responses.
  }
  return `HTTP ${status}: ${trimmed.slice(0, 300)}`;
}

export async function httpComplete(
  build: () => HttpAttempt,
  extract: (body: unknown) => string,
  opts: { fetch: typeof fetch; signal?: AbortSignal; maxAttempts?: number },
): Promise<LlmResult> {
  const attempts = opts.maxAttempts ?? 3;
  let lastError = "request failed";
  let lastStatus: number | null = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (opts.signal?.aborted) return { ok: false, text: "", error: "request aborted" };
    const { url, init } = build();
    let response: Response;
    try {
      response = await opts.fetch(url, { ...init, signal: opts.signal });
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      lastStatus = null;
      if (attempt + 1 < attempts) {
        await wait(250 * 2 ** attempt, opts.signal);
        continue;
      }
      break;
    }
    lastStatus = response.status;
    const text = await readCappedText(response);
    if (text === undefined) {
      return { ok: false, text: "", error: "provider response exceeded size limit", status: response.status };
    }
    if (!response.ok) {
      lastError = describeHttpError(response.status, text);
      if ((response.status === 429 || response.status >= 500) && attempt + 1 < attempts) {
        const retryAfter = Number(response.headers.get("retry-after"));
        await wait(Number.isFinite(retryAfter) ? retryAfter * 1000 : 250 * 2 ** attempt, opts.signal);
        continue;
      }
      return { ok: false, text: "", error: lastError, status: response.status };
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
      const completion = extract(body);
      if (!completion.trim()) throw new Error("provider returned an empty completion");
      return { ok: true, text: completion, status: response.status };
    } catch (error) {
      return {
        ok: false,
        text: "",
        error: error instanceof Error ? error.message : String(error),
        status: response.status,
      };
    }
  }
  return { ok: false, text: "", error: lastError, status: lastStatus };
}
