import { describe, expect, test } from "bun:test";
import { SettingsSaveQueue, type SaveStatus } from "../web/src/lib/settings.ts";
import type { SettingsResponse } from "../web/src/types.ts";

const response = {} as SettingsResponse;

describe("SettingsSaveQueue", () => {
  test("serializes writes and collapses repeated pending paths to the newest value", async () => {
    const writes: Array<[string, unknown]> = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const statuses: SaveStatus[] = [];
    const queue = new SettingsSaveQueue(async (path, value) => {
      writes.push([path, value]);
      if (writes.length === 1) await gate;
      return response;
    }, (status) => statuses.push(status));

    const first = queue.enqueue("llm.provider", "openai");
    const stale = queue.enqueue("llm.providerConfigs.openai.model", "old");
    const latest = queue.enqueue("llm.providerConfigs.openai.model", "new");
    expect(writes).toEqual([["llm.provider", "openai"]]);
    release();
    await Promise.all([first, stale, latest]);
    expect(writes).toEqual([
      ["llm.provider", "openai"],
      ["llm.providerConfigs.openai.model", "new"],
    ]);
    expect(statuses.at(-1)).toEqual({ state: "saved" });
  });

  test("reports an error and continues with later queued work", async () => {
    const statuses: SaveStatus[] = [];
    let calls = 0;
    const queue = new SettingsSaveQueue(async () => {
      calls++;
      if (calls === 1) throw new Error("save failed");
      return response;
    }, (status) => statuses.push(status));
    const failed = queue.enqueue("one", 1).catch((error: Error) => error.message);
    const saved = queue.enqueue("two", 2);
    expect(await failed).toBe("save failed");
    await saved;
    expect(statuses).toContainEqual({ state: "error", error: "save failed" });
    expect(statuses.at(-1)).toEqual({ state: "saved" });
  });
});
