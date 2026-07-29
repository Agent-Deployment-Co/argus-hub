// Rewrites a hub label's description from a reviewer's corrections to the classifier's
// verdicts, so the next preview run better matches what the reviewer actually wants. See
// AUTO_LABEL_PLAN.md and classify-label.ts.

import { complete, type LlmClientDeps } from "./index.ts";
import { sanitizeLlmError } from "./resolve.ts";
import type { ResolvedLlmConfig } from "./types.ts";

export interface LabelCorrection {
  description: string;
  classifierMatched: boolean;
  correctedMatched: boolean;
  reasoning?: string;
}

export interface RefineLabelDescriptor {
  name: string;
  description: string | null;
}

export type RefineLabelResult =
  | { ok: true; description: string }
  | { ok: false; error: string };

const REFINE_MAX_TOKENS = 300;

const REFINE_SYSTEM_PROMPT = [
  "You improve a hub label's description so an LLM classifier applies it correctly to tasks",
  "in the future. You're given the label's name, its current description, and a list of tasks",
  "where a human reviewer overrode the classifier's verdict. Rewrite the description so it",
  "captures what those corrections reveal about the label's true scope. Keep it concise (1-3",
  "sentences), written as a plain description of the label, not as instructions to the",
  "classifier. Reply with EXACTLY the new description text and nothing else.",
].join("\n");

function buildRefinePrompt(label: RefineLabelDescriptor, corrections: LabelCorrection[]): string {
  const lines = [
    `Label: ${label.name}`,
    `Current description: ${label.description ?? "(none provided)"}`,
    "",
    "Corrections a human reviewer made to the classifier's verdicts:",
    ...corrections.map((c) => {
      const from = c.classifierMatched ? "matched" : "did not match";
      const to = c.correctedMatched ? "should match" : "should not match";
      const reason = c.reasoning ? ` The classifier's reasoning was: "${c.reasoning}".` : "";
      return `- Task: "${c.description}" — the classifier said it ${from}, but the reviewer says it ${to}.${reason}`;
    }),
  ];
  return lines.join("\n");
}

export async function refineLabelDescription(
  label: RefineLabelDescriptor,
  corrections: LabelCorrection[],
  config: ResolvedLlmConfig,
  deps: LlmClientDeps = {},
  signal?: AbortSignal,
): Promise<RefineLabelResult> {
  const result = await complete(
    {
      system: REFINE_SYSTEM_PROMPT,
      prompt: buildRefinePrompt(label, corrections),
      maxTokens: REFINE_MAX_TOKENS,
      signal,
    },
    config,
    deps,
  );
  if (!result.ok) {
    return { ok: false, error: sanitizeLlmError(result.error, result.status, config.provider, config.apiKey) };
  }
  const description = result.text.trim();
  if (!description) return { ok: false, error: "Empty response from the classifier." };
  return { ok: true, description };
}
