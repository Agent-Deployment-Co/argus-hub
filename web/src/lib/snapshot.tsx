import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { createContext, useContext, type ReactNode } from "react";
import type { Dashboard, Snapshot } from "../types";

export interface SnapshotFilters {
  since?: string;
  until?: string;
  source?: string;
  /** Scope to one user's data. Omit for the org-wide team rollup. */
  userId?: string;
}

export const KNOWN_SOURCES = ["claude", "codex", "gemini", "cowork"] as const;

function sanitizedSource(source: string | undefined): string | null {
  return source && (KNOWN_SOURCES as readonly string[]).includes(source) ? source : null;
}

function snapshotQueryKey(filters: SnapshotFilters) {
  return ["snapshot", filters.userId ?? null, filters.since ?? null, filters.until ?? null, sanitizedSource(filters.source)] as const;
}

function snapshotUrl(filters: SnapshotFilters): string {
  const params = new URLSearchParams();
  if (filters.userId) params.set("user", filters.userId);
  if (filters.since) params.set("since", filters.since);
  if (filters.until) params.set("until", filters.until);
  const source = sanitizedSource(filters.source);
  if (source) params.set("source", source);
  return `/api/snapshot?${params.toString()}`;
}

async function fetchSnapshot(filters: SnapshotFilters): Promise<Snapshot> {
  const res = await fetch(snapshotUrl(filters));
  if (!res.ok) {
    const body = await res.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error ?? `Failed to load data (${res.status})`);
  }
  return res.json();
}

export function useSnapshotQuery(filters: SnapshotFilters, enabled = true) {
  return useQuery({
    queryKey: snapshotQueryKey(filters),
    queryFn: () => fetchSnapshot(filters),
    staleTime: 30_000,
    placeholderData: keepPreviousData,
    enabled,
  });
}

const Ctx = createContext<Snapshot | null>(null);

export function SnapshotProvider({ value, children }: { value: Snapshot; children: ReactNode }) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSnapshot(): Snapshot {
  const snap = useContext(Ctx);
  if (!snap) throw new Error("useSnapshot must be used within a SnapshotProvider");
  return snap;
}

export function useDashboard(): Dashboard {
  return useSnapshot().dashboard;
}
