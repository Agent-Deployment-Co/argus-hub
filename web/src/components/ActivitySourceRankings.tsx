import { DataTable, type Column } from "./DataTable";
import { fmt, usd } from "../lib/format";
import { sourceLabel } from "../lib/filters";
import type { SourceActivityRow } from "../types";

function successRateLabel(rate: number | null): string {
  return rate === null ? "no outcomes yet" : `${Math.round(rate * 100)}% success`;
}

const columns: Column<SourceActivityRow>[] = [
  { id: "source", label: "Source", sortValue: (r) => sourceLabel(r.source), cell: (r) => sourceLabel(r.source) },
  { id: "sessions", label: "Sessions", num: true, sortValue: (r) => r.sessions, cell: (r) => fmt(r.sessions) },
  { id: "distinctUsers", label: "Users", num: true, sortValue: (r) => r.distinctUsers, cell: (r) => r.distinctUsers },
  { id: "tokens", label: "Tokens", num: true, sortValue: (r) => r.tokens, cell: (r) => fmt(r.tokens) },
  { id: "cost", label: "Cost", num: true, sortValue: (r) => r.cost, cell: (r) => usd(r.cost) },
  { id: "taskSuccessRate", label: "Task outcomes", sortValue: (r) => r.taskSuccessRate ?? -1, cell: (r) => successRateLabel(r.taskSuccessRate) },
];

/** Most/least active sources, per SPEC.md 4.4 — one table, sorted descending by sessions so the
 *  bottom row reads as the adoption laggard (an org can have at most 4 sources, so a mini-list
 *  split isn't needed the way it is for users). */
export function ActivitySourceRankings({ bySource }: { bySource: SourceActivityRow[] }) {
  if (bySource.length === 0) return null;
  const leastAdopted = bySource[bySource.length - 1]!;

  return (
    <section>
      <h2>Sources</h2>
      <DataTable columns={columns} rows={bySource} initialSort="sessions" />
      <p className="note">
        Sorted by sessions, descending. <strong>{sourceLabel(leastAdopted.source)}</strong> is the
        least-adopted tool this window — a candidate for more onboarding, or for retiring if it's
        not earning its keep.
      </p>
    </section>
  );
}
