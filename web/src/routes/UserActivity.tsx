import { getRouteApi, Link, useParams } from "@tanstack/react-router";
import { Dashboard } from "../components/Dashboard";
import { FilterBar } from "../components/FilterBar";
import { DEFAULT_SINCE, DEFAULT_UNTIL, isFilterActive } from "../lib/filters";
import { SnapshotProvider, useSnapshotQuery } from "../lib/snapshot";
import { useUserInfo } from "../lib/users";

const routeApi = getRouteApi("/users/$userId");

export function UserActivity() {
  const { userId } = useParams({ from: "/users/$userId" });
  const search = routeApi.useSearch();
  const navigate = routeApi.useNavigate();
  const userInfo = useUserInfo(userId);
  const since = search.since ?? DEFAULT_SINCE();
  const until = search.until ?? DEFAULT_UNTIL();
  const source = search.source ?? "";
  const filters = { since, until, source, userId };
  const query = useSnapshotQuery(filters);
  const snap = query.data;
  const displayName = userInfo.data?.displayName ?? userId;

  const patchFilters = (patch: Partial<{ since: string; until: string; source: string }>) =>
    navigate({
      to: ".",
      search: (prev: { since?: string; until?: string; source?: string }) => ({
        since: "since" in patch ? patch.since || undefined : prev.since,
        until: "until" in patch ? patch.until || undefined : prev.until,
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
        <div>
          <Link to="/users" className="hub-org-link">← Team</Link>
          <h1>{displayName}</h1>
        </div>
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
