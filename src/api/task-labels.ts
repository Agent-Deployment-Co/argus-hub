// Request/response shaping for the hub-labels HTTP surface (GET/POST/DELETE /api/labels,
// POST /api/task-labels). Kept out of serve.ts for consistency with the rest of the API layer's
// param-parsing modules.

import { taskLabelKey, type TaskLabelRef, type TaskLabelRow } from "../store/hub-store.ts";
import type { TaskListItem } from "./task-list.ts";

/** Mutate `rows` in place, filling each item's `labels` from a previously-fetched lookup map. */
export function attachLabels(rows: TaskListItem[], labelsByKey: Map<string, TaskLabelRow[]>): void {
  for (const row of rows) {
    const found = labelsByKey.get(taskLabelKey(row));
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

/** Validate a wire-provided array of task refs (the auto-apply review wizard's confirmed set).
 *  `undefined`/absent means "no refs" (`[]`), not invalid. Returns null if `input` is present
 *  but not an array, or any element fails `parseTaskRef`. */
export function parseTaskRefs(input: unknown): TaskLabelRef[] | null {
  if (input === undefined) return [];
  if (!Array.isArray(input)) return null;
  const refs: TaskLabelRef[] = [];
  for (const item of input) {
    if (!item || typeof item !== "object") return null;
    const ref = parseTaskRef(item as TaskRefInput);
    if (!ref) return null;
    refs.push(ref);
  }
  return refs;
}
