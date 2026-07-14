import { Link } from "@tanstack/react-router";
import { DataTable, type Column } from "./DataTable";
import { fmt, usd } from "../lib/format";
import type { ActivityFreshness, UserActivityRow } from "../types";

function FreshnessPill({ freshness }: { freshness: ActivityFreshness }) {
  if (freshness === "silent") return <span className="pill freshness-silent">Silent — not syncing</span>;
  if (freshness === "idle") return <span className="pill freshness-idle">Idle</span>;
  return <span className="pill freshness-active">Active</span>;
}

function successRateLabel(rate: number | null): string {
  return rate === null ? "no outcomes yet" : `${Math.round(rate * 100)}% success`;
}

const columns: Column<UserActivityRow>[] = [
  {
    id: "displayName", label: "User", sortValue: (r) => r.displayName,
    cell: (r) => <Link to="/users/$userId" params={{ userId: r.userId }} className="table-link">{r.displayName}</Link>,
  },
  { id: "score", label: "Activity score", num: true, sortValue: (r) => r.score, cell: (r) => r.score },
  { id: "sessions", label: "Sessions", num: true, sortValue: (r) => r.sessions, cell: (r) => fmt(r.sessions) },
  { id: "activeDays", label: "Active days", num: true, sortValue: (r) => r.activeDays, cell: (r) => r.activeDays },
  { id: "tasks", label: "Tasks", num: true, sortValue: (r) => r.tasks, cell: (r) => <>{fmt(r.tasks)} <span className="muted">({successRateLabel(r.taskSuccessRate)})</span></> },
  { id: "tokens", label: "Tokens", num: true, sortValue: (r) => r.tokens, cell: (r) => fmt(r.tokens) },
  { id: "cost", label: "Cost", num: true, sortValue: (r) => r.cost, cell: (r) => usd(r.cost) },
  {
    id: "lastActiveMs", label: "Last active", sortValue: (r) => r.lastActiveMs ?? 0,
    cell: (r) => (r.lastActiveMs ? new Date(r.lastActiveMs).toLocaleDateString() : "—"),
  },
  { id: "freshness", label: "Status", sortValue: (r) => r.freshness, cell: (r) => <FreshnessPill freshness={r.freshness} /> },
];

function MiniRankList({ title, rows, ascending }: { title: string; rows: UserActivityRow[]; ascending?: boolean }) {
  return (
    <div className="panel">
      <h3>{title}</h3>
      <ol className="rank-list">
        {rows.map((r, i) => (
          <li key={r.userId} className="rank-row">
            <span className="rank-num">{ascending ? rows.length - i : i + 1}</span>
            <Link to="/users/$userId" params={{ userId: r.userId }} className="table-link rank-name">{r.displayName}</Link>
            <FreshnessPill freshness={r.freshness} />
            <span className="rank-score">{r.score}</span>
          </li>
        ))}
        {rows.length === 0 && <p className="muted">Not enough data yet.</p>}
      </ol>
    </div>
  );
}

/** Most/least active users, per SPEC.md 4.3 — explicit top-5 / bottom-5 lists (never an
 *  unordered list) plus the full sortable, auditable table underneath. */
export function ActivityUserRankings({ byUser, minCohortGuard }: { byUser: UserActivityRow[]; minCohortGuard: boolean }) {
  if (minCohortGuard) {
    return (
      <section>
        <h2>Users</h2>
        <p className="muted">
          Per-user rankings are hidden until the org has at least 3 teammates — avoids singling
          out one person in a small org.
        </p>
      </section>
    );
  }
  if (byUser.length === 0) return null;

  const mostActive = byUser.slice(0, 5);
  const leastActive = byUser.slice(-5).reverse();

  return (
    <section>
      <h2>Users</h2>
      <div className="grid2">
        <MiniRankList title="Most active" rows={mostActive} />
        <MiniRankList title="Least active" rows={leastActive} ascending />
      </div>
      <p className="note">
        Activity score is a transparent 0–100 blend of active days, sessions, and tokens (each
        normalized to the busiest user this window, weighted equally) — every raw measure is
        shown below so the ranking is auditable. <strong>Silent</strong> means the client hasn't
        synced in 3+ days; <strong>idle</strong> means it's syncing but scoring low.
      </p>
      <div style={{ marginTop: 16 }}>
        <DataTable columns={columns} rows={byUser} initialSort="score" />
      </div>
    </section>
  );
}
