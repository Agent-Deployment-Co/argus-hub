// Request/response shaping for the hub-labels HTTP surface (GET/POST/DELETE /api/labels,
// POST /api/labels/candidates, POST /api/task-labels). Kept out of serve.ts because the
// candidate-search flow does real work (reading tasks, calling the classifier) beyond simple
// param parsing.

import type { HubStore, TaskLabelRef, TaskLabelRow } from "../store/hub-store.ts";
import type { TaskListItem } from "./task-list.ts";
import {
  CANDIDATE_SEARCH_MAX_TASKS,
  searchCandidates,
  type ClassifyBatch,
} from "../classify/task-labeler.ts";

export function taskLabelKey(ref: TaskLabelRef): string {
  return `${ref.clientId}:${ref.sessionId}:${ref.taskSeq}`;
}

/** Mutate `rows` in place, filling each item's `labels` from a previously-fetched lookup map. */
export function attachLabels(rows: TaskListItem[], labelsByKey: Map<string, TaskLabelRow[]>): void {
  for (const row of rows) {
    const found = labelsByKey.get(`${row.clientId}:${row.sessionId}:${row.taskSeq}`);
    if (found?.length) {
      row.labels = found.map((l) => ({ labelId: l.labelId, name: l.name, kind: l.kind, appliedBy: l.appliedBy }));
    }
  }
}

export interface LabelCandidate {
  clientId: string;
  sessionId: string;
  taskSeq: number;
  description: string;
  outcome?: string;
  reason: string;
}

export interface CandidateSearchResult {
  candidates: LabelCandidate[];
  consideredCount: number;
  truncated: boolean;
}

/** Run candidate search for a prospective auto-label over the org's existing tasks. Only tasks
 *  the classifier judged a match are returned — the admin reviews this list down (removing
 *  non-matches) rather than starting from every task. Capped to the most recent
 *  CANDIDATE_SEARCH_MAX_TASKS tasks; `truncated` tells the caller when older tasks were skipped. */
export async function runCandidateSearch(
  store: HubStore,
  orgId: string,
  name: string,
  description: string,
  classifyBatch: ClassifyBatch,
): Promise<CandidateSearchResult> {
  const allTasks = await store.readTaskFacts({ orgId });
  const truncated = allTasks.length > CANDIDATE_SEARCH_MAX_TASKS;
  const considered = allTasks.slice(0, CANDIDATE_SEARCH_MAX_TASKS);

  const inputs = considered.map((row) => ({
    ref: taskLabelKey({ clientId: row.clientId, sessionId: row.sessionId, taskSeq: row.taskSeq }),
    description: row.task.description,
    outcome: row.task.outcome,
  }));

  const results = await searchCandidates(name, description, inputs, classifyBatch);

  const byRef = new Map(considered.map((row) => [
    taskLabelKey({ clientId: row.clientId, sessionId: row.sessionId, taskSeq: row.taskSeq }),
    row,
  ]));

  const candidates: LabelCandidate[] = [];
  for (const result of results) {
    if (!result.match) continue;
    const row = byRef.get(result.ref);
    if (!row) continue;
    candidates.push({
      clientId: row.clientId,
      sessionId: row.sessionId,
      taskSeq: row.taskSeq,
      description: row.task.description,
      outcome: row.task.outcome,
      reason: result.reason,
    });
  }

  return { candidates, consideredCount: considered.length, truncated };
}

export interface TaskRefInput {
  clientId?: unknown;
  sessionId?: unknown;
  taskSeq?: unknown;
}

/** Validate a wire-provided task ref (clientId/sessionId strings, taskSeq an integer). */
export function parseTaskRef(input: TaskRefInput): TaskLabelRef | null {
  if (
    typeof input.clientId !== "string" || !input.clientId ||
    typeof input.sessionId !== "string" || !input.sessionId ||
    typeof input.taskSeq !== "number" || !Number.isInteger(input.taskSeq)
  ) {
    return null;
  }
  return { clientId: input.clientId, sessionId: input.sessionId, taskSeq: input.taskSeq };
}
