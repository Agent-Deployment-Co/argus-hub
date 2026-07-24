// Request/response shaping for the hub-labels HTTP surface (GET/POST/DELETE /api/labels,
// POST /api/task-labels). Kept out of serve.ts for consistency with the rest of the API layer's
// param-parsing modules.

import type { TaskLabelRef, TaskLabelRow } from "../store/hub-store.ts";
import type { TaskListItem } from "./task-list.ts";

export function taskLabelKey(ref: TaskLabelRef): string {
  return `${ref.clientId}:${ref.sessionId}:${ref.taskSeq}`;
}

/** Mutate `rows` in place, filling each item's `labels` from a previously-fetched lookup map. */
export function attachLabels(rows: TaskListItem[], labelsByKey: Map<string, TaskLabelRow[]>): void {
  for (const row of rows) {
    const found = labelsByKey.get(`${row.clientId}:${row.sessionId}:${row.taskSeq}`);
    if (found?.length) {
      row.labels = found.map((l) => ({ labelId: l.labelId, name: l.name }));
    }
  }
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
