import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { sanitizedSource } from "./filters";
import type { SessionDetailResponse, SessionDetailRow, SessionListResponse, SessionSort } from "../types";

/** URL search-param shape for the /sessions route tree (declared here, not router.tsx, so both
 *  the router's validateSearch and the Sessions/SessionDetail components can import it without
 *  a circular router.tsx <-> route-component import). */
export interface SessionsSearch {
  since?: string;
  until?: string;
  source?: string;
  user?: string;
  q?: string;
  sort?: SessionSort;
}

export interface SessionListParams {
  since?: string;
  until?: string;
  source?: string;
  userId?: string;
  sort: SessionSort;
  limit: number;
  offset: number;
  q?: string;
}

function sessionListUrl(params: SessionListParams): string {
  const search = new URLSearchParams({ sort: params.sort, limit: String(params.limit), offset: String(params.offset) });
  if (params.since) search.set("since", params.since);
  if (params.until) search.set("until", params.until);
  const source = sanitizedSource(params.source);
  if (source) search.set("source", source);
  if (params.userId) search.set("user", params.userId);
  if (params.q) search.set("q", params.q);
  return `/api/sessions?${search.toString()}`;
}

async function fetchSessionList(params: SessionListParams): Promise<SessionListResponse> {
  const res = await fetch(sessionListUrl(params));
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Failed to load sessions (${res.status})`);
  }
  return res.json();
}

export function useSessionList(params: SessionListParams) {
  return useQuery({
    queryKey: ["sessions", params],
    queryFn: () => fetchSessionList(params),
    staleTime: 15_000,
    placeholderData: keepPreviousData,
  });
}

async function fetchSessionDetail(sessionId: string, userId: string | undefined): Promise<SessionDetailRow> {
  const search = userId ? `?user=${encodeURIComponent(userId)}` : "";
  const res = await fetch(`/api/session/${encodeURIComponent(sessionId)}${search}`);
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Failed to load session (${res.status})`);
  }
  const body = (await res.json()) as SessionDetailResponse;
  return body.session;
}

export function useSessionDetail(sessionId: string, userId: string | undefined) {
  return useQuery({
    queryKey: ["session", sessionId, userId ?? null],
    queryFn: () => fetchSessionDetail(sessionId, userId),
    staleTime: 15_000,
    enabled: !!sessionId,
  });
}
