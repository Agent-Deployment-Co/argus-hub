import { classifyOutcome } from "../api/task-list.ts";
import { cost, unpricedModels } from "../pricing.ts";
import type {
  ActivityDayPoint,
  ActivityFreshness,
  ActivityReport,
  ActivityTaskCounts,
  ActivityTotals,
  AgentSource,
  SourceActivityRow,
  TaskFact,
  Usage,
  UserActivityRow,
} from "../types.ts";
import { totalTokens } from "../types.ts";

/** A client is "silent" if it hasn't uploaded in this long — stale relative to `now`,
 *  independent of the report window (a user can be silent even mid-window). */
const SILENT_THRESHOLD_MS = 3 * 24 * 60 * 60 * 1000;

/** Below the org-wide user-count privacy floor, per-user rankings are withheld rather than
 *  singling out one person in a tiny org (SPEC.md 6, "Privacy floor"). Shared with the Tasks
 *  report (reporting/tasks.ts) so both pages apply the same policy. */
export const MIN_COHORT_FOR_RANKINGS = 3;

function usageTotals(byModel: Array<{ model: string; usage: Usage }>): { tokens: number; cost: number } {
  let tokens = 0;
  let costTotal = 0;
  for (const { model, usage } of byModel) {
    tokens += totalTokens(usage);
    costTotal += cost(usage, model);
  }
  return { tokens, cost: costTotal };
}

function emptyTaskCounts(): ActivityTaskCounts {
  return { total: 0, success: 0, failure: 0, unknown: 0 };
}

function foldTask(bucket: ActivityTaskCounts, outcome: "success" | "failure" | "unknown"): void {
  bucket.total += 1;
  bucket[outcome] += 1;
}

// ---- Date helpers (ISO YYYY-MM-DD, no ambient Date.now()/timezone surprises) -----------

function parseIsoDate(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d));
}

function formatIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDaysIso(iso: string, days: number): string {
  const d = parseIsoDate(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return formatIsoDate(d);
}

function daysBetweenInclusive(since: string, until: string): number {
  const ms = parseIsoDate(until).getTime() - parseIsoDate(since).getTime();
  return Math.round(ms / 86_400_000) + 1;
}

/** The equal-length window immediately preceding [since, until], used for WoW-style deltas. */
export function previousWindow(since: string, until: string): { since: string; until: string } {
  const span = daysBetweenInclusive(since, until);
  return { since: addDaysIso(since, -span), until: addDaysIso(since, -1) };
}

/** Every ISO date in [since, until], inclusive — used to fill idle-day gaps in daily series so
 *  the x-axis always spans the full window (client's readActiveDates pattern). Exported for
 *  reuse by reporting/tasks.ts. */
export function everyDateInclusive(since: string, until: string): string[] {
  const out: string[] = [];
  let cur = since;
  while (cur <= until) {
    out.push(cur);
    cur = addDaysIso(cur, 1);
  }
  return out;
}

// ---- Raw inputs (fetched by the caller from HubStore) ----------------------------------

export interface ActivityWindowTotalsRaw {
  sessions: number;
  activeUsers: number;
  byModel: Array<{ model: string; usage: Usage }>;
}

export interface ActivityUserRollupRaw {
  userId: string;
  displayName: string;
  sessions: number;
  activeDays: number;
  lastActiveMs: number | null;
  lastSyncMs: number;
  byModel: Array<{ model: string; usage: Usage }>;
}

export interface ActivitySourceRollupRaw {
  source: string;
  sessions: number;
  distinctUsers: number;
  byModel: Array<{ model: string; usage: Usage }>;
}

export interface ActivityDailyRaw {
  date: string;
  sessions: number;
  activeUsers: number;
  tokens: number;
}

export interface AssembleActivityReportInput {
  since: string;
  until: string;
  previousSince: string;
  previousUntil: string;
  currentTotals: ActivityWindowTotalsRaw;
  previousTotals: ActivityWindowTotalsRaw;
  daily: ActivityDailyRaw[];
  byUser: ActivityUserRollupRaw[];
  bySource: ActivitySourceRollupRaw[];
  /** Every task in the current window, from readTaskFacts (outcome classified here so this
   *  report and the Tasks tab always agree on what counts as success/failure/unknown). */
  currentTasks: Array<{ task: TaskFact; userId: string | null }>;
  previousTasks: Array<{ task: TaskFact }>;
  nowMs: number;
}

function freshnessFor(lastSyncMs: number, nowMs: number, score: number): ActivityFreshness {
  if (nowMs - lastSyncMs >= SILENT_THRESHOLD_MS) return "silent";
  if (score < 34) return "idle";
  return "active";
}

/** Transparent, documented composite: equal-weighted blend of active-days, sessions, and
 *  tokens, each normalized to the busiest user in the cohort (0-100). Every row also carries
 *  its raw measures so the ranking is auditable, not a black box (SPEC.md 4.3). */
function computeScores(rows: ActivityUserRollupRaw[], tokensByUser: Map<string, number>): Map<string, number> {
  const maxDays = Math.max(1, ...rows.map((r) => r.activeDays));
  const maxSessions = Math.max(1, ...rows.map((r) => r.sessions));
  const maxTokens = Math.max(1, ...rows.map((r) => tokensByUser.get(r.userId) ?? 0));
  const scores = new Map<string, number>();
  for (const r of rows) {
    const normDays = r.activeDays / maxDays;
    const normSessions = r.sessions / maxSessions;
    const normTokens = (tokensByUser.get(r.userId) ?? 0) / maxTokens;
    scores.set(r.userId, Math.round(100 * ((normDays + normSessions + normTokens) / 3)));
  }
  return scores;
}

export function assembleActivityReport(input: AssembleActivityReportInput): ActivityReport {
  const currentUsage = usageTotals(input.currentTotals.byModel);
  const previousUsage = usageTotals(input.previousTotals.byModel);

  const currentTaskCounts = emptyTaskCounts();
  const taskCountsByUser = new Map<string, ActivityTaskCounts>();
  const taskCountsBySource = new Map<string, ActivityTaskCounts>();
  const tasksByDate = new Map<string, number>();
  for (const { task, userId } of input.currentTasks) {
    const outcome = classifyOutcome(task.outcome);
    foldTask(currentTaskCounts, outcome);
    if (userId) {
      const bucket = taskCountsByUser.get(userId) ?? emptyTaskCounts();
      taskCountsByUser.set(userId, bucket);
      foldTask(bucket, outcome);
    }
    const srcBucket = taskCountsBySource.get(task.source) ?? emptyTaskCounts();
    taskCountsBySource.set(task.source, srcBucket);
    foldTask(srcBucket, outcome);

    const dateMs = task.timestampMs ?? null;
    if (dateMs) {
      const date = formatIsoDate(new Date(dateMs));
      tasksByDate.set(date, (tasksByDate.get(date) ?? 0) + 1);
    }
  }

  const previousTaskCounts = emptyTaskCounts();
  for (const { task } of input.previousTasks) foldTask(previousTaskCounts, classifyOutcome(task.outcome));

  const totals: ActivityTotals = {
    sessions: input.currentTotals.sessions,
    activeUsers: input.currentTotals.activeUsers,
    tasks: currentTaskCounts,
    tokens: currentUsage.tokens,
    cost: currentUsage.cost,
  };
  const previousTotals: ActivityTotals = {
    sessions: input.previousTotals.sessions,
    activeUsers: input.previousTotals.activeUsers,
    tasks: previousTaskCounts,
    tokens: previousUsage.tokens,
    cost: previousUsage.cost,
  };

  const dailyByDate = new Map(input.daily.map((d) => [d.date, d]));
  const daily: ActivityDayPoint[] = everyDateInclusive(input.since, input.until).map((date) => {
    const row = dailyByDate.get(date);
    return {
      date,
      sessions: row?.sessions ?? 0,
      activeUsers: row?.activeUsers ?? 0,
      tokens: row?.tokens ?? 0,
      tasks: tasksByDate.get(date) ?? 0,
    };
  });

  const tokensByUser = new Map(input.byUser.map((r) => [r.userId, usageTotals(r.byModel).tokens]));
  const scores = computeScores(input.byUser, tokensByUser);
  const minCohortGuard = input.byUser.length < MIN_COHORT_FOR_RANKINGS;

  const byUser: UserActivityRow[] = minCohortGuard
    ? []
    : input.byUser
        .map((r) => {
          const { tokens, cost: userCost } = usageTotals(r.byModel);
          const taskCounts = taskCountsByUser.get(r.userId) ?? emptyTaskCounts();
          const score = scores.get(r.userId) ?? 0;
          const denom = taskCounts.success + taskCounts.failure;
          return {
            userId: r.userId,
            displayName: r.displayName,
            sessions: r.sessions,
            tasks: taskCounts.total,
            taskSuccessRate: denom > 0 ? taskCounts.success / denom : null,
            tokens,
            cost: userCost,
            activeDays: r.activeDays,
            lastActiveMs: r.lastActiveMs,
            lastSyncMs: r.lastSyncMs,
            freshness: freshnessFor(r.lastSyncMs, input.nowMs, score),
            score,
          };
        })
        .sort((a, b) => b.score - a.score);

  const bySource: SourceActivityRow[] = input.bySource
    .map((r) => {
      const { tokens, cost: sourceCost } = usageTotals(r.byModel);
      const taskCounts = taskCountsBySource.get(r.source) ?? emptyTaskCounts();
      const denom = taskCounts.success + taskCounts.failure;
      return {
        source: r.source as AgentSource,
        sessions: r.sessions,
        distinctUsers: r.distinctUsers,
        tokens,
        cost: sourceCost,
        taskSuccessRate: denom > 0 ? taskCounts.success / denom : null,
      };
    })
    .sort((a, b) => b.sessions - a.sessions);

  return {
    generatedAtMs: input.nowMs,
    range: { since: input.since, until: input.until },
    previousRange: { since: input.previousSince, until: input.previousUntil },
    totals,
    previousTotals,
    daily,
    byUser,
    bySource,
    unpriced: unpricedModels(),
    minCohortGuard,
  };
}
