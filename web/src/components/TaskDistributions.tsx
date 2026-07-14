import type { ChartOptions } from "chart.js";
import { ChartCanvas } from "./charts/ChartCanvas";
import type { FrustrationCounts, TaskOutcomeCounts } from "../types";

const OUTCOME_COLORS = ["#6cc08b", "#e2302c", "#887060"];
const FRUSTRATION_COLORS = ["#887060", "#ef8920", "#e2302c"];

/** Outcome + frustration distributions for the window (SPEC.md 5.2) — donuts, not bars, since
 *  these are parts of one whole rather than independently-scaled measures. */
export function TaskDistributions({ outcomes, frustration }: { outcomes: TaskOutcomeCounts; frustration: FrustrationCounts }) {
  const frustrationKnown = frustration.none + frustration.moderate + frustration.high;
  return (
    <div className="grid2">
      <div className="panel">
        <h3>Outcome distribution</h3>
        <ChartCanvas
          type="doughnut"
          height={220}
          data={{
            labels: ["Success", "Failure", "Unclear"],
            datasets: [{ data: [outcomes.success, outcomes.failure, outcomes.unknown], backgroundColor: OUTCOME_COLORS }],
          }}
          options={{ plugins: { legend: { position: "right" } } } satisfies ChartOptions<"doughnut">}
        />
        {outcomes.total === 0 && <p className="muted">No outcomes recorded yet.</p>}
      </div>
      <div className="panel">
        <h3>Frustration distribution</h3>
        <ChartCanvas
          type="doughnut"
          height={220}
          data={{
            labels: ["None", "Moderate", "High"],
            datasets: [{ data: [frustration.none, frustration.moderate, frustration.high], backgroundColor: FRUSTRATION_COLORS }],
          }}
          options={{ plugins: { legend: { position: "right" } } } satisfies ChartOptions<"doughnut">}
        />
        {frustrationKnown === 0 && <p className="muted">No frustration signals recorded yet.</p>}
      </div>
    </div>
  );
}
