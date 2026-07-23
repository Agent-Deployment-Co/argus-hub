import { getRouteApi } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { ActivityCostByModel } from "../components/ActivityCostByModel";
import { ActivitySourceRankings } from "../components/ActivitySourceRankings";
import { ActivityTiles } from "../components/ActivityTiles";
import { ActivityTimeSeries } from "../components/ActivityTimeSeries";
import { ActivityUserRankings } from "../components/ActivityUserRankings";
import { FilterBar } from "../components/FilterBar";
import { useActivityQuery } from "../lib/activity";
import { DEFAULT_SINCE, DEFAULT_UNTIL, isFilterActive } from "../lib/filters";

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

/** The Hub's home page: at a glance, how much agent work the org did in the window, and how
 *  it's distributed across people and tools (SPEC.md 4). Org-wide only — no ?user= scope, but
 *  ?group= narrows to a group's members. */
export function Activity() {
  const search = routeApi.useSearch();
  const navigate = routeApi.useNavigate();
  const since = search.since ?? DEFAULT_SINCE();
  const until = search.until ?? DEFAULT_UNTIL();
  const source = search.source ?? "";
  const group = search.group ?? "";
  const filters = { since, until, source, groupId: group };
  const query = useActivityQuery(filters);
  const report = query.data;

  const patchFilters = (patch: Partial<{ since: string; until: string; source: string; groupId: string }>) =>
    navigate({
      to: ".",
      search: (prev: { since?: string; until?: string; source?: string; group?: string }) => ({
        since: "since" in patch ? patch.since || undefined : prev.since,
        until: "until" in patch ? patch.until || undefined : prev.until,
        source: "source" in patch ? patch.source || undefined : prev.source,
        group: "groupId" in patch ? patch.groupId || undefined : prev.group,
      }),
      replace: true,
    });

  return (
    <>
      <FilterBar
        since={since}
        until={until}
        source={source}
        groupId={group}
        showGroup
        loading={query.isFetching}
        onChange={patchFilters}
        onReset={() => navigate({ to: ".", search: {}, replace: true })}
        resettable={isFilterActive(filters, { since: DEFAULT_SINCE(), until: DEFAULT_UNTIL() })}
      />
      <div className="page-head">
        <h1>Activity</h1>
      </div>
      {query.isPending ? (
        <div className="center-state">Loading…</div>
      ) : query.isError ? (
        <div className="center-state">{errorMessage(query.error as Error)}</div>
      ) : (
        <>
          <section>
            <ActivityTiles totals={report!.totals} previousTotals={report!.previousTotals} />
            {report!.unpriced.length > 0 && (
              <p className="note">Unpriced models (cost excluded): {report!.unpriced.join(", ")}.</p>
            )}
          </section>

          <section>
            <ActivityTimeSeries daily={report!.daily} />
          </section>

          {report!.costByModel.length > 0 && (
            <section>
              <ActivityCostByModel costByModel={report!.costByModel} />
            </section>
          )}

          <ActivityUserRankings byUser={report!.byUser} minCohortGuard={report!.minCohortGuard} />
          <ActivitySourceRankings bySource={report!.bySource} />
        </>
      )}
    </>
  );
}
