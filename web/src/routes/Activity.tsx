import { getRouteApi } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { Dashboard } from "../components/Dashboard";
import { FilterBar } from "../components/FilterBar";
import { DEFAULT_SINCE, DEFAULT_UNTIL, isFilterActive } from "../lib/filters";
import { SnapshotProvider, useSnapshotQuery } from "../lib/snapshot";

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

const routeApi = getRouteApi("/");

/** The Hub's home page: a roll-up of every user's activity across the whole team (no ?user=
 *  scope, so /api/snapshot aggregates every synced client in the org). */
export function Activity() {
  const search = routeApi.useSearch();
  const navigate = routeApi.useNavigate();
  const since = search.since ?? DEFAULT_SINCE();
  const until = search.until ?? DEFAULT_UNTIL();
  const source = search.source ?? "";
  const filters = { since, until, source };
  const query = useSnapshotQuery(filters);
  const snap = query.data;

  const patchFilters = (patch: Partial<{ since: string; until: string; source: string }>) =>
    navigate({
      to: ".",
      search: (prev: { since?: string; until?: string; source?: string }) => ({
        since: patch.since !== undefined ? patch.since || undefined : prev.since,
        until: patch.until !== undefined ? patch.until || undefined : prev.until,
        source: "source" in patch ? patch.source || undefined : prev.source,
      }),
      replace: true,
    });

  return (
    <>
      <FilterBar
        since={since}
        until={until}
        source={source}
        loading={query.isFetching}
        onChange={patchFilters}
        onReset={() => navigate({ to: ".", search: {}, replace: true })}
        resettable={isFilterActive(search, { since: DEFAULT_SINCE(), until: DEFAULT_UNTIL() })}
      />
      <div className="page-head">
        <h1>Team Activity</h1>
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
