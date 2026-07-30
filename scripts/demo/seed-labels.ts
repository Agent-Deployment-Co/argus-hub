// Seeds the hub-level labels (see scenarios.ts `HUB_LABELS`) into an already-seeded demo store and
// applies them to the tasks `generate.ts` picked out. Split out from `demo.ts` so `test/demo.test.ts`
// can exercise the same path without spawning the CLI.
import type { HubStore } from "../../src/store/hub-store.ts";
import type { DemoData } from "./generate.ts";

export interface SeedLabelsResult {
  labels: number;
  applications: number;
}

/** Create every `data.labels` entry, then apply them to `data.taskLabels` at `atMs`. `atMs` is
 *  passed through (rather than each call's own `Date.now()`) so re-running with the same
 *  `--as-of`/`--seed` reproduces identical `created_at`/`applied_at_ms` timestamps. */
export async function seedDemoLabels(
  store: HubStore,
  orgId: string,
  data: DemoData,
  atMs: number,
): Promise<SeedLabelsResult> {
  const labelIds = new Map<string, string>();
  for (const seed of data.labels) {
    const info = await store.createLabel(orgId, seed.name, seed.description, atMs);
    labelIds.set(seed.name, info.labelId);
  }

  let applications = 0;
  for (const assignment of data.taskLabels) {
    for (const name of assignment.labelNames) {
      const labelId = labelIds.get(name);
      if (!labelId) continue; // shouldn't happen — labelsForTask only emits names in HUB_LABELS
      await store.setTaskLabel(
        orgId,
        { clientId: assignment.clientId, sessionId: assignment.sessionId, taskSeq: assignment.taskSeq },
        labelId,
        true,
        atMs,
      );
      applications++;
    }
  }

  return { labels: labelIds.size, applications };
}
