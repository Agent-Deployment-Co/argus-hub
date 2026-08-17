import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { TaskReport } from "../types";
import { sanitizedSource, type FilterValues } from "./filters";

function taskReportQueryKey(filters: FilterValues, flagged: boolean) {
  return [
    "task-report",
    filters.since ?? null,
    filters.until ?? null,
    sanitizedSource(filters.source),
    filters.userId ?? null,
    filters.groupId ?? null,
    flagged,
  ] as const;
}

function taskReportUrl(filters: FilterValues, flagged: boolean): string {
  const params = new URLSearchParams();
  if (filters.since) params.set("since", filters.since);
  if (filters.until) params.set("until", filters.until);
  const source = sanitizedSource(filters.source);
  if (source) params.set("source", source);
  if (filters.userId) params.set("user", filters.userId);
  if (filters.groupId) params.set("group", filters.groupId);
  if (flagged) params.set("flagged", "1");
  return `/api/tasks/report?${params.toString()}`;
}

async function fetchTaskReport(filters: FilterValues, flagged: boolean): Promise<TaskReport> {
  const res = await fetch(taskReportUrl(filters, flagged));
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Failed to load data (${res.status})`);
  }
  return res.json();
}

export function useTaskReportQuery(filters: FilterValues, flagged = false) {
  return useQuery({
    queryKey: taskReportQueryKey(filters, flagged),
    queryFn: () => fetchTaskReport(filters, flagged),
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });
}

/** `rate` is a 0..1 fraction or null (no known measurements yet). */
export function pct(rate: number | null): string {
  return rate === null ? "—" : `${Math.round(rate * 100)}%`;
}
