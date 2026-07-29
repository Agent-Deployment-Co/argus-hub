// Per-task LLM judgment for the auto-apply label review wizard: given a label's name +
// description and a task's text, decide whether the label applies. See AUTO_LABEL_PLAN.md.

import { complete, type LlmClientDeps } from "./index.ts";
import { sanitizeLlmError } from "./resolve.ts";
import type { ResolvedLlmConfig } from "./types.ts";
import type { TaskLabelRef } from "../store/hub-store.ts";

export interface ClassifiableTask {
  ref: TaskLabelRef;
  description: string;
}

export interface LabelClassification {
  ref: TaskLabelRef;
  matched: boolean;
  reasoning?: string;
}

export interface ClassifyLabelDescriptor {
  name: string;
  description: string | null;
}

// Small enough that a 10-task review preview doesn't need a real job queue, large enough that a
// 10-task preview finishes in roughly one round trip instead of ten sequential ones.
const CLASSIFY_CONCURRENCY = 4;
const CLASSIFY_MAX_TOKENS = 120;

const CLASSIFY_SYSTEM_PROMPT = [
  "You decide whether a single task matches a named label, given the label's name and",
  "description. Reply with EXACTLY one line, in the form:",
  "yes: <short reason>",
  "or",
  "no: <short reason>",
  "Do not include anything else in your reply.",
].join("\n");

function buildClassifyPrompt(label: ClassifyLabelDescriptor, taskDescription: string): string {
  return `Label: ${label.name}\nDescription: ${label.description ?? "(no description provided)"}\n\nTask: ${taskDescription}`;
}

const VERDICT_RE = /^(yes|no)\s*:\s*(.*)$/is;
const BARE_VERDICT_RE = /^(yes|no)\b/i;

/** Exported for unit testing the parser in isolation from the network/provider layer. */
export function parseClassifyVerdict(text: string): { matched: boolean; reasoning?: string } {
  const trimmed = text.trim();
  const withReason = VERDICT_RE.exec(trimmed);
  if (withReason) {
    const reasoning = withReason[2]!.trim();
    return { matched: withReason[1]!.toLowerCase() === "yes", reasoning: reasoning || undefined };
  }
  const bare = BARE_VERDICT_RE.exec(trimmed);
  if (bare) return { matched: bare[1]!.toLowerCase() === "yes" };
  return {
    matched: false,
    reasoning: trimmed ? `Unparseable classifier reply: "${trimmed.slice(0, 200)}"` : "Empty classifier reply",
  };
}

async function classifyOne(
  label: ClassifyLabelDescriptor,
  task: ClassifiableTask,
  config: ResolvedLlmConfig,
  deps: LlmClientDeps,
  signal?: AbortSignal,
): Promise<LabelClassification> {
  const result = await complete(
    {
      system: CLASSIFY_SYSTEM_PROMPT,
      prompt: buildClassifyPrompt(label, task.description),
      maxTokens: CLASSIFY_MAX_TOKENS,
      signal,
    },
    config,
    deps,
  );
  if (!result.ok) {
    return {
      ref: task.ref,
      matched: false,
      reasoning: sanitizeLlmError(result.error, result.status, config.provider, config.apiKey),
    };
  }
  const { matched, reasoning } = parseClassifyVerdict(result.text);
  return { ref: task.ref, matched, reasoning };
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Classify each of `tasks` against `label`, one `complete()` call per task, with bounded
 *  concurrency. A single task's provider failure or malformed reply degrades to
 *  `matched: false` with an explanatory `reasoning` — it never throws, so one flaky task can't
 *  fail the whole preview. If `onResult` is given, it fires as each task's classification
 *  resolves (not per-chunk) so a caller can stream results out incrementally. */
export async function classifyTasksForLabel(
  label: ClassifyLabelDescriptor,
  tasks: ClassifiableTask[],
  config: ResolvedLlmConfig,
  deps: LlmClientDeps = {},
  signal?: AbortSignal,
  onResult?: (result: LabelClassification) => void,
): Promise<LabelClassification[]> {
  const out: LabelClassification[] = [];
  for (const part of chunk(tasks, CLASSIFY_CONCURRENCY)) {
    const results = await Promise.all(part.map(async (task) => {
      const result = await classifyOne(label, task, config, deps, signal);
      onResult?.(result);
      return result;
    }));
    out.push(...results);
  }
  return out;
}
