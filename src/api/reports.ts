// Shared report orchestration for the Hub's read APIs.
//
// query-params.ts unifies how the REST routes (src/api/serve.ts) and the MCP tools
// (src/api/mcp.ts) parse filters; this module unifies how they turn those filters into an actual
// report — window defaulting, the HubStore fan-out, and the "no data yet" empty-guard — so the
// two surfaces can't drift on those decisions either.

import type { HubScope, HubStore } from "../store/hub-store.ts";
import type { ActivityReport, ResolvedQuery, TaskReport } from "../types.ts";
import { assembleActivityReport, previousWindow } from "../reporting/activity.ts";
import { assembleTaskReport } from "../reporting/tasks.ts";
import { cost } from "../pricing.ts";

/** Default a query's since/until to the last `days` days ending today (UTC), anchored to `now`
 *  so callers (and their tests) can control "today". */
export function resolveWindow(
  query: ResolvedQuery, now: Date, days = 30,
): { since: string; until: string } {
  const isoDaysAgo = (n: number) => {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - n);
    return d.toISOString().slice(0, 10);
  };
  return { since: query.since ?? isoDaysAgo(days), until: query.until ?? isoDaysAgo(0) };
}

/** Usage/cost activity report for a window vs. the previous window. `null` when the scope has
 *  no data in either window ("No data yet." for both REST and MCP callers). */
export async function buildActivityReport(
  store: HubStore, scope: HubScope, query: ResolvedQuery, now: Date,
): Promise<ActivityReport | null> {
  const { since, until } = resolveWindow(query, now);
  const currentQuery = { ...query, since, until };
  const { since: previousSince, until: previousUntil } = previousWindow(since, until);
  const previousQuery = { ...query, since: previousSince, until: previousUntil };

  const [currentTotals, previousTotals, daily, byUser, bySource, currentTasks, previousTasks] =
    await Promise.all([
      store.readActivityTotals(scope, currentQuery),
      store.readActivityTotals(scope, previousQuery),
      store.readActivityDaily(scope, currentQuery),
      store.readActivityUserRollup(scope, currentQuery),
      store.readActivitySourceRollup(scope, currentQuery),
      store.readTaskFacts(scope, currentQuery),
      store.readTaskFacts(scope, previousQuery),
    ]);

  if (currentTotals.sessions === 0 && previousTotals.sessions === 0 && byUser.length === 0) return null;

  return assembleActivityReport({
    since, until, previousSince, previousUntil,
    currentTotals, previousTotals, daily, byUser, bySource,
    currentTasks: currentTasks.map((r) => ({ task: r.task, userId: r.userId })),
    previousTasks: previousTasks.map((r) => ({ task: r.task })),
    nowMs: now.getTime(),
  });
}

/** Task outcomes/friction report for a window. `null` when the scope has no sessions
 *  ("No data yet." for both REST and MCP callers). */
export async function buildTaskQualityReport(
  store: HubStore, scope: HubScope, query: ResolvedQuery, now: Date,
): Promise<TaskReport | null> {
  const { since, until } = resolveWindow(query, now);
  const currentQuery = { ...query, since, until };

  const [rows, friction, totals] = await Promise.all([
    store.readTaskFacts(scope, currentQuery),
    store.readWindowFrictionRollup(scope, currentQuery),
    store.readActivityTotals(scope, currentQuery),
  ]);

  if (totals.sessions === 0) return null;

  return assembleTaskReport({ since, until, rows, friction, nowMs: now.getTime() });
}

export interface UserRosterRow {
  userId: string;
  displayName: string;
  email: string | null;
  lastSyncMs: number;
  sessionCount: number;
  clientCount: number;
  totalTokens: number;
  cost: number;
}

/** Roster of known users with token/cost totals, or `[]` when the org has no data yet. */
export async function buildUserRoster(store: HubStore, orgId: string | null | undefined): Promise<UserRosterRow[]> {
  if (!orgId) return [];
  const stats = await store.readUserStats(orgId);
  return stats.map(({ userId, displayName, email, lastSyncMs, sessionCount, clientCount, byModel }) => {
    const totalTokens = byModel.reduce(
      (s, m) => s + m.input + m.output + m.cacheRead + m.cacheWrite5m + m.cacheWrite1h, 0,
    );
    const totalCost = byModel.reduce(
      (s, m) => s + cost({ input: m.input, output: m.output, cacheRead: m.cacheRead, cacheWrite5m: m.cacheWrite5m, cacheWrite1h: m.cacheWrite1h }, m.model),
      0,
    );
    return { userId, displayName, email, lastSyncMs, sessionCount, clientCount, totalTokens, cost: totalCost };
  });
}
