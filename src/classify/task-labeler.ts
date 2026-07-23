// LLM-backed candidate search for auto-applied hub labels (#26). Given a label name +
// description and a set of existing tasks, asks Claude which tasks match, batched to keep each
// request small and to bound the blast radius of a single malformed response.

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

/** Injected into the classifier so tests can substitute a stub instead of calling the real API. */
export type ClassifyBatch = (
  labelName: string,
  labelDescription: string,
  tasks: ClassifyTaskInput[],
) => Promise<ClassifyTaskResult[]>;

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const MODEL = "claude-sonnet-5";
const BATCH_SIZE = 20;
/** Safety cap on how many tasks a single candidate search considers, so an org with a very large
 *  task history can't turn one label-creation click into thousands of LLM calls. Candidate
 *  search runs over the most recent tasks first; anything beyond this is left unclassified (the
 *  admin can re-run once description-editing/re-run ships — see ARGUS_HUB_LABELS_PLAN.md). */
export const CANDIDATE_SEARCH_MAX_TASKS = 500;

const CLASSIFY_TOOL_NAME = "report_matches";

function classifyToolSchema() {
  return {
    name: CLASSIFY_TOOL_NAME,
    description: "Report which tasks match the given label.",
    input_schema: {
      type: "object",
      properties: {
        matches: {
          type: "array",
          items: {
            type: "object",
            properties: {
              ref: { type: "string" },
              match: { type: "boolean" },
              reason: { type: "string" },
            },
            required: ["ref", "match", "reason"],
          },
        },
      },
      required: ["matches"],
    },
  };
}

function buildPrompt(labelName: string, labelDescription: string, tasks: ClassifyTaskInput[]): string {
  const lines = tasks.map(
    (t) => `- ref: ${t.ref}\n  description: ${t.description}\n  outcome: ${t.outcome ?? "(unknown)"}`,
  );
  return (
    `A hub admin is creating a task label named "${labelName}" with this description:\n` +
    `"${labelDescription}"\n\n` +
    `For each task below, decide whether it matches the label's description. ` +
    `Call ${CLASSIFY_TOOL_NAME} with one entry per task ref, in the same order, each with a ` +
    `short one-sentence reason.\n\n${lines.join("\n")}`
  );
}

/** Real classifier: one Anthropic Messages API call per batch, forced to call the
 *  report_matches tool so the response is structured. Throws if ANTHROPIC_API_KEY is unset. */
export const classifyBatchViaAnthropic: ClassifyBatch = async (labelName, labelDescription, tasks) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Candidate search for auto-applied labels requires an Anthropic API key.",
    );
  }

  const res = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4096,
      tools: [classifyToolSchema()],
      tool_choice: { type: "tool", name: CLASSIFY_TOOL_NAME },
      messages: [{ role: "user", content: buildPrompt(labelName, labelDescription, tasks) }],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Anthropic API error (${res.status}): ${body.slice(0, 500)}`);
  }

  const data = (await res.json()) as {
    content?: { type: string; input?: { matches?: unknown } }[];
  };
  const toolUse = data.content?.find((b) => b.type === "tool_use");
  const matches = toolUse?.input?.matches;
  if (!Array.isArray(matches)) return tasks.map((t) => ({ ref: t.ref, match: false, reason: "No response from classifier." }));

  const known = new Set(tasks.map((t) => t.ref));
  return matches
    .filter((m): m is { ref: string; match: boolean; reason: string } =>
      typeof m === "object" && m !== null && typeof (m as { ref?: unknown }).ref === "string" && known.has((m as { ref: string }).ref))
    .map((m) => ({ ref: m.ref, match: !!m.match, reason: typeof m.reason === "string" ? m.reason : "" }));
};

/** Classify all `tasks` against a label, batching requests and running batches concurrently.
 *  Tasks the model didn't return a verdict for (e.g. a malformed batch response) are omitted
 *  from the result rather than guessed at. */
export async function searchCandidates(
  labelName: string,
  labelDescription: string,
  tasks: ClassifyTaskInput[],
  classifyBatch: ClassifyBatch = classifyBatchViaAnthropic,
): Promise<ClassifyTaskResult[]> {
  const batches: ClassifyTaskInput[][] = [];
  for (let i = 0; i < tasks.length; i += BATCH_SIZE) batches.push(tasks.slice(i, i + BATCH_SIZE));

  const results = await Promise.all(batches.map((batch) => classifyBatch(labelName, labelDescription, batch)));
  return results.flat();
}
