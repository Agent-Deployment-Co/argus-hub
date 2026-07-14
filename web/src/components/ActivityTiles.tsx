import { ArrowDown, ArrowUp } from "lucide-react";
import { deltaPct } from "../lib/activity";
import { fmt, usd } from "../lib/format";
import type { ActivityTotals } from "../types";
import { StatCards, type Stat } from "./StatCards";

/** "+12% vs. prior 30d" / "−4% vs. prior 30d" — every headline tile reads as a trend, not
 *  just a snapshot (SPEC.md 4.1). Omitted when there's no prior-window baseline to compare. */
function Delta({ current, previous }: { current: number; previous: number }) {
  const pct = deltaPct(current, previous);
  if (pct === null) return null;
  const rounded = Math.round(pct);
  if (rounded === 0) return <span className="stat-delta flat">flat vs. prior window</span>;
  const up = rounded > 0;
  return (
    <span className={`stat-delta ${up ? "up" : "down"}`}>
      {up ? <ArrowUp size={11} strokeWidth={2.5} aria-hidden /> : <ArrowDown size={11} strokeWidth={2.5} aria-hidden />}
      {Math.abs(rounded)}% vs. prior window
    </span>
  );
}

export function ActivityTiles({ totals, previousTotals }: { totals: ActivityTotals; previousTotals: ActivityTotals }) {
  const successDenom = totals.tasks.success + totals.tasks.failure;
  const successRate = successDenom > 0 ? Math.round((100 * totals.tasks.success) / successDenom) : null;

  const stats: Stat[] = [
    {
      label: "Active sessions",
      value: (
        <>
          {fmt(totals.sessions)}
          <Delta current={totals.sessions} previous={previousTotals.sessions} />
        </>
      ),
    },
    {
      label: "Tasks",
      value: (
        <>
          {fmt(totals.tasks.total)} <small>{successRate !== null ? `${successRate}% success` : "no outcomes yet"}</small>
          <Delta current={totals.tasks.total} previous={previousTotals.tasks.total} />
        </>
      ),
    },
    {
      label: "Token usage",
      value: (
        <>
          {fmt(totals.tokens)} <small>{usd(totals.cost)}</small>
          <Delta current={totals.tokens} previous={previousTotals.tokens} />
        </>
      ),
    },
    {
      label: "Active users",
      value: (
        <>
          {fmt(totals.activeUsers)}
          <Delta current={totals.activeUsers} previous={previousTotals.activeUsers} />
        </>
      ),
    },
  ];

  return <StatCards stats={stats} />;
}
