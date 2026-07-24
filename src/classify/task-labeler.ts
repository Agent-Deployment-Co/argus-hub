import { complete, type LlmClientDeps } from "../llm/index.ts";
import { sanitizeLlmError } from "../llm/resolve.ts";
import type { ResolvedLlmConfig } from "../llm/types.ts";

export const CANDIDATE_SEARCH_MAX_TASKS = 500;
export const CLASSIFY_BATCH_SIZE = 20;
export const CLASSIFY_CONCURRENCY = 3;

export interface ClassifyTaskInput {
  ref: string;
  description: string;
  outcome?: string;
}

export interface ClassifyTaskResult {
  ref: string;
  match: boolean;
  reason: string;
}

export type ClassifyBatch = (
  labelName: string,
  labelDescription: string,
  tasks: ClassifyTaskInput[],
) => Promise<ClassifyTaskResult[]>;

function promptFor(
  labelName: string,
  labelDescription: string,
  tasks: ClassifyTaskInput[],
): string {
  return JSON.stringify({
    instruction: "Classify every task against the label. Return only strict JSON: {\"matches\":[{\"ref\":\"...\",\"match\":true,\"reason\":\"short reason\"}]}.",
    label: { name: labelName, description: labelDescription },
    tasks,
  });
}

export function parseClassifierOutput(text: string, tasks: ClassifyTaskInput[]): ClassifyTaskResult[] {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return []; }
  const matches = (parsed as { matches?: unknown } | null)?.matches;
  if (!Array.isArray(matches)) return [];
  const known = new Set(tasks.map((task) => task.ref));
  const seen = new Set<string>();
  const results: ClassifyTaskResult[] = [];
  for (const item of matches) {
    if (!item || typeof item !== "object") continue;
    const row = item as { ref?: unknown; match?: unknown; reason?: unknown };
    if (typeof row.ref !== "string" || !known.has(row.ref) || seen.has(row.ref)) continue;
    if (typeof row.match !== "boolean" || typeof row.reason !== "string") continue;
    seen.add(row.ref);
    results.push({ ref: row.ref, match: row.match, reason: row.reason.trim().slice(0, 240) });
  }
  return results;
}

export function createProviderClassifier(
  config: ResolvedLlmConfig,
  deps: LlmClientDeps = {},
  timeoutMs = 20_000,
): ClassifyBatch {
  return async (labelName, labelDescription, tasks) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const result = await complete({
        prompt: promptFor(labelName, labelDescription, tasks),
        maxTokens: 4096,
        signal: controller.signal,
      }, config, deps);
      if (!result.ok) {
        throw new Error(sanitizeLlmError(result.error, result.status, config.provider, config.apiKey));
      }
      return parseClassifierOutput(result.text, tasks);
    } finally {
      clearTimeout(timeout);
    }
  };
}

export async function searchCandidates(
  labelName: string,
  labelDescription: string,
  tasks: ClassifyTaskInput[],
  classifyBatch: ClassifyBatch,
): Promise<ClassifyTaskResult[]> {
  const batches: ClassifyTaskInput[][] = [];
  for (let index = 0; index < tasks.length; index += CLASSIFY_BATCH_SIZE) {
    batches.push(tasks.slice(index, index + CLASSIFY_BATCH_SIZE));
  }
  const results: ClassifyTaskResult[][] = new Array(batches.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(CLASSIFY_CONCURRENCY, batches.length) },
    async () => {
      while (next < batches.length) {
        const index = next++;
        const batch = batches[index]!;
        results[index] = await classifyBatch(labelName, labelDescription, batch);
      }
    },
  );
  await Promise.all(workers);
  return results.flat();
}
