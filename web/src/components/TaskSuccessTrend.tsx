import type { ChartOptions } from "chart.js";
import { ChartCanvas } from "./charts/ChartCanvas";
import type { TaskDayPoint } from "../types";

const fmtPct = (v: number | string) => `${Math.round(Number(v))}%`;

/** Daily success-rate line so quality trend is visible, not just a window snapshot (SPEC.md 5.2).
 *  Days with no resolved outcomes plot a gap rather than a misleading 0%. */
export function TaskSuccessTrend({ daily }: { daily: TaskDayPoint[] }) {
  return (
    <div className="panel">
      <h3>Outcome over time</h3>
      <ChartCanvas
        type="line"
        height={240}
        data={{
          labels: daily.map((d) => d.date),
          datasets: [
            {
              label: "Success rate",
              data: daily.map((d) => (d.successRate === null ? null : Math.round(d.successRate * 100))),
              borderColor: "#6cc08b",
              backgroundColor: "#6cc08b",
              spanGaps: false,
              tension: 0.25,
            },
          ],
        }}
        options={{
          plugins: { legend: { display: false } },
          scales: {
            x: { ticks: { maxRotation: 90, minRotation: 45 } },
            y: { min: 0, max: 100, ticks: { callback: fmtPct } },
          },
        } satisfies ChartOptions<"line">}
      />
    </div>
  );
}
