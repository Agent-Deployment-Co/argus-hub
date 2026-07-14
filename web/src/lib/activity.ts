import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { ActivityReport } from "../types";
import { sanitizedSource, type FilterValues } from "./filters";

export type ActivityFilters = Omit<FilterValues, "userId">;

function activityQueryKey(filters: ActivityFilters) {
  return ["activity", filters.since ?? null, filters.until ?? null, sanitizedSource(filters.source)] as const;
}

function activityUrl(filters: ActivityFilters): string {
  const params = new URLSearchParams();
  if (filters.since) params.set("since", filters.since);
  if (filters.until) params.set("until", filters.until);
  const source = sanitizedSource(filters.source);
  if (source) params.set("source", source);
  return `/api/activity?${params.toString()}`;
}

async function fetchActivity(filters: ActivityFilters): Promise<ActivityReport> {
  const res = await fetch(activityUrl(filters));
  if (!res.ok) {
    const body = await res.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error ?? `Failed to load data (${res.status})`);
  }
  return res.json();
}

export function useActivityQuery(filters: ActivityFilters) {
  return useQuery({
    queryKey: activityQueryKey(filters),
    queryFn: () => fetchActivity(filters),
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });
}

/** Percent change vs. the prior equal-length window; null when there's nothing to compare
 *  against (avoids a misleading "+∞%" the first time a measure goes from 0 to something). */
export function deltaPct(current: number, previous: number): number | null {
  if (previous === 0) return current === 0 ? 0 : null;
  return ((current - previous) / previous) * 100;
}
