import type { ChartOptions } from "chart.js";
import { useState } from "react";
import { ChartCanvas } from "./charts/ChartCanvas";
import { fmt, usd, SERIES } from "../lib/format";
import type { ActivityDayPoint } from "../types";

type Measure = "sessions" | "tasks" | "tokens" | "cost" | "activeUsers";

const MEASURES: { key: Measure; label: string }[] = [
  { key: "sessions", label: "Sessions" },
  { key: "tasks", label: "Tasks" },
  { key: "tokens", label: "Tokens" },
  { key: "cost", label: "Cost" },
  { key: "activeUsers", label: "Active users" },
];

const fmtTick = (v: number | string) => fmt(Number(v));
const usdTick = (v: number | string) => usd(Number(v));

/** Daily time series with a sessions/tasks/tokens/active-users toggle. The x-axis is every day
 *  in the window (including idle days) — the backend already fills gaps, per readActiveDates. */
export function ActivityTimeSeries({ daily }: { daily: ActivityDayPoint[] }) {
  const [measure, setMeasure] = useState<Measure>("sessions");
  const active = MEASURES.find((m) => m.key === measure)!;
  const isCost = measure === "cost";

  return (
    <div className="panel">
      <div className="section-title-row">
        <h3>Activity over time</h3>
        <div className="task-filters-outcomes" role="group" aria-label="Measure to plot">
          {MEASURES.map((m) => (
            <label key={m.key} className={`filter-toggle${measure === m.key ? " selected" : ""}`}>
              <input
                type="radio"
                name="activity-measure"
                checked={measure === m.key}
                onChange={() => setMeasure(m.key)}
              />
              {m.label}
            </label>
          ))}
        </div>
      </div>
      <ChartCanvas
        type="bar"
        height={260}
        data={{
          labels: daily.map((d) => d.date),
          datasets: [{ label: active.label, data: daily.map((d) => d[measure]), backgroundColor: SERIES.accent }],
        }}
        options={{
          plugins: {
            legend: { display: false },
            ...(isCost ? { tooltip: { callbacks: { label: (c) => usd(Number(c.parsed.y)) } } } : {}),
          },
          scales: {
            x: { ticks: { maxRotation: 90, minRotation: 45 } },
            y: { ticks: { callback: isCost ? usdTick : fmtTick } },
          },
        } satisfies ChartOptions<"bar">}
      />
    </div>
  );
}
