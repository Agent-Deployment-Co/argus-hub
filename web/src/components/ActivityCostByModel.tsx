import type { ChartOptions } from "chart.js";
import { ChartCanvas } from "./charts/ChartCanvas";
import { fmt, modelFamilyColor, usd } from "../lib/format";
import type { ModelCostRow } from "../types";

const usdTick = (v: number | string) => usd(Number(v));

/** Where the window's spend actually went, by model — the single most decision-relevant cut of
 *  the headline cost tile (are we over-spending on the priciest model?). Unpriced models are
 *  excluded upstream and called out separately via the report's `unpriced` note. */
export function ActivityCostByModel({ costByModel }: { costByModel: ModelCostRow[] }) {
  if (costByModel.length === 0) return null;
  const total = costByModel.reduce((s, r) => s + r.cost, 0);

  return (
    <div className="panel">
      <h3>Cost by model</h3>
      <ChartCanvas
        type="bar"
        height={Math.max(160, costByModel.length * 34 + 40)}
        data={{
          labels: costByModel.map((r) => r.model),
          datasets: [
            {
              label: "cost",
              data: costByModel.map((r) => r.cost),
              backgroundColor: costByModel.map((r) => modelFamilyColor(r.model)),
            },
          ],
        }}
        options={{
          indexAxis: "y",
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: {
                label: (c) => {
                  const row = costByModel[c.dataIndex]!;
                  const share = total > 0 ? Math.round((100 * row.cost) / total) : 0;
                  return `${usd(row.cost)} · ${share}% of spend · ${fmt(row.tokens)} tok`;
                },
              },
            },
          },
          scales: { x: { ticks: { callback: usdTick } } },
        } satisfies ChartOptions<"bar">}
      />
    </div>
  );
}
