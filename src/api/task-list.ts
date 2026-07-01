import type { HubTaskRow } from "../store/hub-store.ts";
import type { AgentSource, TaskFact } from "../types.ts";

export interface TaskListItem {
  id: string;
  source: AgentSource;
  sessionId: string;
  project: string;
  timestampMs: number | null;
  description: string;
  outcome?: string;
  outcomeReason?: string;
  frustration?: string;
  signals?: string[];
}

export interface TaskListCounts {
  success: number;
  failure: number;
  unknown: number;
}

export interface TaskListResponse {
  rows: TaskListItem[];
  total: number;
  offset: number;
  limit: number;
  counts: TaskListCounts;
}

export interface TaskListParams {
  limit: number;
  offset: number;
  q?: string;
}

function listItem(row: HubTaskRow): TaskListItem {
  const t: TaskFact = row.task;
  return {
    id: t.id,
    source: t.source,
    sessionId: row.sessionId,
    project: row.project,
    timestampMs: t.timestampMs ?? null,
    description: t.description,
    outcome: t.outcome,
    outcomeReason: t.outcomeReason,
    frustration: t.frustration,
    signals: t.signals,
  };
}

export function classifyOutcome(outcome?: string): "success" | "failure" | "unknown" {
  const v = (outcome ?? "").toLowerCase();
  if (v.includes("fail") || v.includes("abandon") || v.includes("block")) return "failure";
  if (v.includes("success") || v.includes("complete") || v.includes("done") || v.includes("resolved")) return "success";
  return "unknown";
}

function countOutcomes(items: TaskListItem[]): TaskListCounts {
  const counts: TaskListCounts = { success: 0, failure: 0, unknown: 0 };
  for (const it of items) counts[classifyOutcome(it.outcome)]++;
  return counts;
}

export function buildTaskList(rows: HubTaskRow[], params: TaskListParams): TaskListResponse {
  const term = params.q?.trim().toLowerCase();
  let items = rows.map(listItem);
  if (term) {
    items = items.filter((it) =>
      it.description.toLowerCase().includes(term) || it.project.toLowerCase().includes(term),
    );
  }
  const total = items.length;
  const offset = Math.max(0, params.offset);
  const page = items.slice(offset, offset + params.limit);
  return { rows: page, total, offset, limit: params.limit, counts: countOutcomes(items) };
}
