import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { useState } from "react";
import { Dashboard } from "../components/Dashboard";
import { SnapshotProvider, useSnapshotQuery, type SnapshotFilters } from "../lib/snapshot";

interface UserInfo { userId: string; email: string; orgId: string; orgName: string; displayName: string }

async function fetchUserInfo(userId: string): Promise<UserInfo> {
  const res = await fetch(`/api/user/${encodeURIComponent(userId)}`);
  if (!res.ok) throw new Error(`Failed to load user (${res.status})`);
  return res.json();
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function UserActivity() {
  const { userId } = useParams({ from: "/users/$userId" });
  const userInfo = useQuery({ queryKey: ["user-info", userId], queryFn: () => fetchUserInfo(userId), staleTime: 60_000 });
  const [filters] = useState<SnapshotFilters>(() => ({ since: daysAgo(30), until: daysAgo(0), userId }));
  const query = useSnapshotQuery(filters);
  const snap = query.data;
  const displayName = userInfo.data?.displayName ?? userId;

  return (
    <>
      <div className="page-head">
        <div>
          <Link to="/users" className="hub-org-link">← Team</Link>
          <h1>{displayName}</h1>
        </div>
        <span className="page-range">{filters.since} → {filters.until}</span>
      </div>
      {query.isPending ? (
        <div className="center-state">Loading…</div>
      ) : query.isError ? (
        <div className="center-state">Couldn't load data: {(query.error as Error).message}</div>
      ) : (
        <SnapshotProvider value={snap!}>
          <Dashboard />
        </SnapshotProvider>
      )}
    </>
  );
}
