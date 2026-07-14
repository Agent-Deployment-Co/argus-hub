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

export type TaskOutcomeFilter = "success" | "failure" | "unknown";

export interface TaskListParams {
  limit: number;
  offset: number;
  q?: string;
  /** When set, only rows classifying to one of these outcomes are returned. The top-of-page
   *  counts are computed from this same filtered set, so they reflect the active filters. */
  outcomes?: TaskOutcomeFilter[];
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

const NEGATION_RE = /\b(?:un|in|non)\w+|\bnot\s+\w+/;

export function classifyOutcome(outcome?: string): "success" | "failure" | "unknown" {
  const v = (outcome ?? "").toLowerCase();
  const negated = NEGATION_RE.test(v);
  if (v.includes("fail") || v.includes("abandon") || v.includes("block")) return "failure";
  if (v.includes("success") || v.includes("complete") || v.includes("done") || v.includes("resolved")) {
    return negated ? "unknown" : "success";
  }
  return "unknown";
}

/** Classifies a task's free-text `frustration` into the three-tier SPEC.md 5.2 bucket, so the
 *  Tasks report and any per-row pill always agree on what counts as moderate/high. */
const HIGH_FRUSTRATION_RE = /\b(?:high|severe)\b/;
const NO_FRUSTRATION_RE = /\bnone\b/;

export function classifyFrustration(frustration?: string): "none" | "moderate" | "high" | "unknown" {
  const v = (frustration ?? "").toLowerCase().trim();
  if (!v) return "unknown";
  if (HIGH_FRUSTRATION_RE.test(v)) return "high";
  if (NO_FRUSTRATION_RE.test(v) || v === "0") return "none";
  return "moderate";
}

export function buildTaskList(rows: HubTaskRow[], params: TaskListParams): TaskListResponse {
  const term = params.q?.trim().toLowerCase();
  const allowed = params.outcomes?.length ? new Set(params.outcomes) : null;
  const counts: TaskListCounts = { success: 0, failure: 0, unknown: 0 };
  const items: TaskListItem[] = [];
  for (const row of rows) {
    if (term && !row.task.description.toLowerCase().includes(term) && !row.project.toLowerCase().includes(term)) continue;
    const outcome = classifyOutcome(row.task.outcome);
    if (allowed && !allowed.has(outcome)) continue;
    counts[outcome]++;
    items.push(listItem(row));
  }
  const total = items.length;
  const offset = Math.max(0, params.offset);
  const page = items.slice(offset, offset + params.limit);
  return { rows: page, total, offset, limit: params.limit, counts };
}
