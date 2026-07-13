import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { DataTable, type Column } from "./DataTable";
import { fmt } from "../lib/format";
import { pct } from "../lib/tasks-report";
import { sourceLabel } from "../lib/filters";
import type { TaskQualityRow } from "../types";

function qualityColumns(labelHeader: string, labelCell: (r: TaskQualityRow) => ReactNode): Column<TaskQualityRow>[] {
  return [
    { id: "label", label: labelHeader, sortValue: (r) => r.label, cell: labelCell },
    { id: "total", label: "Tasks", num: true, sortValue: (r) => r.total, cell: (r) => fmt(r.total) },
    { id: "successRate", label: "Success rate", num: true, sortValue: (r) => r.successRate ?? -1, cell: (r) => pct(r.successRate) },
    { id: "frustrationRate", label: "Frustration rate", num: true, sortValue: (r) => r.frustrationRate ?? -1, cell: (r) => pct(r.frustrationRate) },
  ];
}

function rankMetric(r: TaskQualityRow): number {
  // successRate ties broken by volume so a 1-task 100% row doesn't outrank a 50-task 90% row.
  return r.successRate === null ? -1 : r.successRate * 1000 + Math.min(r.total, 999) / 1000;
}

function MiniRankList({ title, rows, ascending }: { title: string; rows: TaskQualityRow[]; ascending?: boolean }) {
  return (
    <div className="panel">
      <h3>{title}</h3>
      <ol className="rank-list">
        {rows.map((r, i) => (
          <li key={r.key} className="rank-row">
            <span className="rank-num">{ascending ? rows.length - i : i + 1}</span>
            <Link to="/users/$userId" params={{ userId: r.key }} className="table-link rank-name">{r.label}</Link>
            <span className="muted">{fmt(r.total)} tasks</span>
            <span className="rank-score">{pct(r.successRate)}</span>
          </li>
        ))}
        {rows.length === 0 && <p className="muted">Not enough data yet.</p>}
      </ol>
    </div>
  );
}

/** Task quality by user (SPEC.md 5.3) — top/bottom performers, mirroring Activity's user
 *  rankings, plus the full auditable table. Withheld below the org-wide privacy floor. */
export function TaskQualityByUser({ rows, minCohortGuard }: { rows: TaskQualityRow[]; minCohortGuard: boolean }) {
  if (minCohortGuard) {
    return (
      <section>
        <h2>Task quality by user</h2>
        <p className="muted">
          Per-user rankings are hidden until the org has at least 3 teammates — avoids singling
          out one person in a small org.
        </p>
      </section>
    );
  }
  if (rows.length === 0) return null;

  const ranked = [...rows].sort((a, b) => rankMetric(b) - rankMetric(a));
  const top = ranked.slice(0, 5);
  const bottom = ranked.slice(-5).reverse();
  const columns = qualityColumns("User", (r) => (
    <Link to="/users/$userId" params={{ userId: r.key }} className="table-link">{r.label}</Link>
  ));

  return (
    <section>
      <h2>Task quality by user</h2>
      <div className="grid2">
        <MiniRankList title="Best outcomes" rows={top} />
        <MiniRankList title="Struggling most" rows={bottom} ascending />
      </div>
      <div style={{ marginTop: 16 }}>
        <DataTable columns={columns} rows={rows} initialSort="total" />
      </div>
    </section>
  );
}

/** Task quality by source (SPEC.md 5.3) — which tool yields the best outcomes for this org. */
export function TaskQualityBySource({ rows }: { rows: TaskQualityRow[] }) {
  if (rows.length === 0) return null;
  const columns = qualityColumns("Source", (r) => sourceLabel(r.label));
  return (
    <section>
      <h2>Task quality by source</h2>
      <DataTable columns={columns} rows={rows} initialSort="total" />
    </section>
  );
}

/** Task quality by project (SPEC.md 5.3) — where work is going smoothly vs. painfully. */
export function TaskQualityByProject({ rows }: { rows: TaskQualityRow[] }) {
  if (rows.length === 0) return null;
  const columns = qualityColumns("Project", (r) => r.label);
  return (
    <section>
      <h2>Task quality by project</h2>
      <DataTable columns={columns} rows={rows} initialSort="total" />
    </section>
  );
}
