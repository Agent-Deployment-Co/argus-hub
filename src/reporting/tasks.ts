import { classifyFrustration, classifyOutcome } from "../api/task-list.ts";
import { everyDateInclusive, MIN_COHORT_FOR_RANKINGS } from "./activity.ts";
import type { HubTaskRow } from "../store/hub-store.ts";
import type {
  FrictionTotals,
  FrustrationCounts,
  TaskOutcomeCounts,
  TaskQualityRow,
  TaskReport,
  TaskSignalRow,
} from "../types.ts";

const INTERRUPTED_DISPOSITIONS = new Set(["interrupted", "incomplete"]);
const KNOWN_DISPOSITIONS = new Set(["completed", "interrupted", "incomplete", "error"]);
const DEFAULT_TOP_SIGNALS_LIMIT = 10;

function emptyOutcomeCounts(): TaskOutcomeCounts {
  return { total: 0, success: 0, failure: 0, unknown: 0 };
}

function emptyFrustrationCounts(): FrustrationCounts {
  return { none: 0, moderate: 0, high: 0, unknown: 0 };
}

interface QualityAccumulator {
  key: string;
  label: string;
  total: number;
  success: number;
  failure: number;
  /** Tasks at moderate/high frustration, among those with a known frustration reading. */
  frustrated: number;
  frustrationKnown: number;
}

function foldQuality(
  map: Map<string, QualityAccumulator>,
  key: string,
  label: string,
  outcome: "success" | "failure" | "unknown",
  frustration: "none" | "moderate" | "high" | "unknown",
): void {
  const acc = map.get(key) ?? { key, label, total: 0, success: 0, failure: 0, frustrated: 0, frustrationKnown: 0 };
  map.set(key, acc);
  acc.total += 1;
  if (outcome === "success") acc.success += 1;
  if (outcome === "failure") acc.failure += 1;
  if (frustration !== "unknown") {
    acc.frustrationKnown += 1;
    if (frustration === "moderate" || frustration === "high") acc.frustrated += 1;
  }
}

/** Sorted descending by task count so the busiest row leads — every ranking here is ordered,
 *  never left in arrival order (SPEC.md 4.5 / "no unordered lists"). */
function finalizeQuality(map: Map<string, QualityAccumulator>): TaskQualityRow[] {
  return [...map.values()]
    .map((a) => {
      const outcomeDenom = a.success + a.failure;
      return {
        key: a.key,
        label: a.label,
        total: a.total,
        success: a.success,
        failure: a.failure,
        successRate: outcomeDenom > 0 ? a.success / outcomeDenom : null,
        frustrationRate: a.frustrationKnown > 0 ? a.frustrated / a.frustrationKnown : null,
      };
    })
    .sort((a, b) => b.total - a.total);
}

export interface AssembleTaskReportInput {
  since: string;
  until: string;
  /** Every task in-window + scope, from readTaskFacts (same source the /tasks list uses, so
   *  the two views always agree on totals). */
  rows: HubTaskRow[];
  /** Session-level interruption/rejection/compaction rollup for the same window (readWindowFrictionRollup). */
  friction: FrictionTotals;
  nowMs: number;
  topSignalsLimit?: number;
}

export function assembleTaskReport(input: AssembleTaskReportInput): TaskReport {
  const outcomes = emptyOutcomeCounts();
  const frustration = emptyFrustrationCounts();
  let interrupted = 0;
  let dispositionKnown = 0;

  const dailyMap = new Map<string, { total: number; success: number; failure: number }>();
  const byUserMap = new Map<string, QualityAccumulator>();
  const bySourceMap = new Map<string, QualityAccumulator>();
  const byProjectMap = new Map<string, QualityAccumulator>();
  const signalCounts = new Map<string, number>();

  for (const row of input.rows) {
    const outcome = classifyOutcome(row.task.outcome);
    const frust = classifyFrustration(row.task.frustration);
    outcomes.total += 1;
    outcomes[outcome] += 1;
    frustration[frust] += 1;

    if (row.disposition && KNOWN_DISPOSITIONS.has(row.disposition)) {
      dispositionKnown += 1;
      if (INTERRUPTED_DISPOSITIONS.has(row.disposition)) interrupted += 1;
    }

    if (row.task.timestampMs) {
      const date = new Date(row.task.timestampMs).toISOString().slice(0, 10);
      const bucket = dailyMap.get(date) ?? { total: 0, success: 0, failure: 0 };
      dailyMap.set(date, bucket);
      bucket.total += 1;
      if (outcome === "success") bucket.success += 1;
      if (outcome === "failure") bucket.failure += 1;
    }

    if (row.userId) foldQuality(byUserMap, row.userId, row.displayName ?? row.userId, outcome, frust);
    foldQuality(bySourceMap, row.task.source, row.task.source, outcome, frust);
    foldQuality(byProjectMap, row.project, row.project, outcome, frust);

    if (outcome === "failure" || frust === "moderate" || frust === "high") {
      for (const signal of row.task.signals ?? []) {
        signalCounts.set(signal, (signalCounts.get(signal) ?? 0) + 1);
      }
    }
  }

  const successDenom = outcomes.success + outcomes.failure;
  const frustrationKnownTotal = frustration.none + frustration.moderate + frustration.high;

  const daily = everyDateInclusive(input.since, input.until).map((date) => {
    const bucket = dailyMap.get(date);
    const denom = bucket ? bucket.success + bucket.failure : 0;
    return {
      date,
      total: bucket?.total ?? 0,
      success: bucket?.success ?? 0,
      failure: bucket?.failure ?? 0,
      successRate: bucket && denom > 0 ? bucket.success / denom : null,
    };
  });

  const topSignals: TaskSignalRow[] = [...signalCounts.entries()]
    .map(([signal, count]) => ({ signal, count }))
    .sort((a, b) => b.count - a.count || a.signal.localeCompare(b.signal))
    .slice(0, input.topSignalsLimit ?? DEFAULT_TOP_SIGNALS_LIMIT);

  const minCohortGuard = byUserMap.size < MIN_COHORT_FOR_RANKINGS;

  return {
    generatedAtMs: input.nowMs,
    range: { since: input.since, until: input.until },
    totals: {
      total: outcomes.total,
      successRate: successDenom > 0 ? outcomes.success / successDenom : null,
      frustrationRate: frustrationKnownTotal > 0 ? (frustration.moderate + frustration.high) / frustrationKnownTotal : null,
      interruptedRate: dispositionKnown > 0 ? interrupted / dispositionKnown : null,
    },
    outcomes,
    frustration,
    daily,
    byUser: minCohortGuard ? [] : finalizeQuality(byUserMap),
    bySource: finalizeQuality(bySourceMap),
    byProject: finalizeQuality(byProjectMap),
    topSignals,
    friction: input.friction,
    minCohortGuard,
  };
}
