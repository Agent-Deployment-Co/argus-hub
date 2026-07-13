import { fmt } from "../lib/format";
import { pct } from "../lib/tasks-report";
import type { TaskTotals } from "../types";
import { StatCards, type Stat } from "./StatCards";

/** Headline tiles for the Tasks page (SPEC.md 5.1) — how *well* the org's work is going, not
 *  just how much of it there was. */
export function TaskTiles({ totals }: { totals: TaskTotals }) {
  const stats: Stat[] = [
    { label: "Total tasks", value: fmt(totals.total) },
    { label: "Success rate", value: pct(totals.successRate) },
    { label: "Frustration rate", value: pct(totals.frustrationRate) },
    { label: "Interrupted / incomplete", value: pct(totals.interruptedRate) },
  ];
  return <StatCards stats={stats} />;
}
