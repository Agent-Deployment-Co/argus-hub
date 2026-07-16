import type { ChartOptions } from "chart.js";
import { ChartCanvas } from "./charts/ChartCanvas";
import type { TaskDayPoint } from "../types";

/** Daily outcome counts stacked by disposition, so quality trend is visible, not just a window
 *  snapshot (SPEC.md 5.2). Unclear = total minus resolved (success + failure). */
export function TaskSuccessTrend({ daily }: { daily: TaskDayPoint[] }) {
  return (
    <div className="panel">
      <h3>Outcome over time</h3>
      <ChartCanvas
        type="bar"
        height={240}
        data={{
          labels: daily.map((d) => d.date),
          datasets: [
            { label: "Success", data: daily.map((d) => d.success), backgroundColor: "#6cc08b" },
            { label: "Failure", data: daily.map((d) => d.failure), backgroundColor: "#e2302c" },
            { label: "Unclear", data: daily.map((d) => d.total - d.success - d.failure), backgroundColor: "#887060" },
          ],
        }}
        options={{
          plugins: { legend: { position: "bottom" } },
          scales: {
            x: { stacked: true, ticks: { maxRotation: 90, minRotation: 45 } },
            y: { stacked: true, min: 0, ticks: { precision: 0 } },
          },
        } satisfies ChartOptions<"bar">}
      />
    </div>
  );
}
