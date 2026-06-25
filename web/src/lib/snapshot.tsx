import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { createContext, useContext, type ReactNode } from "react";
import type { Dashboard, Snapshot } from "../types";
import { useScope } from "./scope";

export interface SnapshotFilters {
  since?: string;
  until?: string;
  source?: string;
}

export const KNOWN_SOURCES = ["claude", "codex", "gemini", "cowork"] as const;

function sanitizedSource(source: string | undefined): string | null {
  return source && (KNOWN_SOURCES as readonly string[]).includes(source) ? source : null;
}

function snapshotQueryKey(userId: string, filters: SnapshotFilters) {
  return ["snapshot", userId, filters.since ?? null, filters.until ?? null, sanitizedSource(filters.source)] as const;
}

function snapshotUrl(userId: string, filters: SnapshotFilters): string {
  const params = new URLSearchParams();
  params.set("user", userId);
  if (filters.since) params.set("since", filters.since);
  if (filters.until) params.set("until", filters.until);
  const source = sanitizedSource(filters.source);
  if (source) params.set("source", source);
  return `/api/snapshot?${params.toString()}`;
}

async function fetchSnapshot(userId: string, filters: SnapshotFilters): Promise<Snapshot> {
  const res = await fetch(snapshotUrl(userId, filters));
  if (!res.ok) throw new Error(`Failed to load data (${res.status})`);
  return res.json();
}

export function useSnapshotQuery(filters: SnapshotFilters, enabled = true) {
  const { userId } = useScope();
  return useQuery({
    queryKey: snapshotQueryKey(userId, filters),
    queryFn: () => fetchSnapshot(userId, filters),
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
