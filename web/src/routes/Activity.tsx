import { useState, type ReactNode } from "react";
import { Dashboard } from "../components/Dashboard";
import { SnapshotProvider, useSnapshotQuery, type SnapshotFilters } from "../lib/snapshot";

function errorMessage(err: Error): ReactNode {
  if (err.message === "No data yet.") {
    return (
      <>
        No data yet. Run <code>argus sync</code> from a client to ingest data.
      </>
    );
  }
  return `Couldn't load data: ${err.message}`;
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** The Hub's home page: a roll-up of every user's activity across the whole team (no ?user=
 *  scope, so /api/snapshot aggregates every synced client in the org). */
export function Activity() {
  const [filters] = useState<SnapshotFilters>(() => ({ since: daysAgo(30), until: daysAgo(0) }));
  const query = useSnapshotQuery(filters);
  const snap = query.data;

  return (
    <>
      <div className="page-head">
        <h1>Team Activity</h1>
        <span className="page-range">{filters.since} → {filters.until}</span>
      </div>
      {query.isPending ? (
        <div className="center-state">Loading…</div>
      ) : query.isError ? (
        <div className="center-state">{errorMessage(query.error as Error)}</div>
      ) : (
        <SnapshotProvider value={snap!}>
          <Dashboard />
        </SnapshotProvider>
      )}
    </>
  );
}
