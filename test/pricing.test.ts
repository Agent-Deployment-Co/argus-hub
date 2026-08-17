import { describe, expect, test } from "bun:test";
import { cost, unpricedModels } from "../src/pricing.ts";
import type { Usage } from "../src/types.ts";

const MTOK = 1_000_000;
const EMPTY: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };

/** Cost of one million tokens of a single kind, so expectations read as the published $/MTok rate. */
const rate = (model: string, field: keyof Usage) => cost({ ...EMPTY, [field]: MTOK }, model);

describe("model price lookup", () => {
  test.each([
    ["claude-fable-5", 10, 50],
    ["claude-mythos-5", 10, 50],
    ["gpt-5.6-sol", 5, 30],
    ["gpt-5.6-terra", 2, 12],
    ["gpt-5.6-luna", 0.2, 1.2],
  ])("prices %s at $%s/$%s per MTok", (model, input, output) => {
    expect(rate(model, "input")).toBeCloseTo(input, 6);
    expect(rate(model, "output")).toBeCloseTo(output, 6);
  });

  test("applies Anthropic cache multipliers to Fable", () => {
    expect(rate("claude-fable-5", "cacheRead")).toBeCloseTo(1, 6);
    expect(rate("claude-fable-5", "cacheWrite5m")).toBeCloseTo(12.5, 6);
    expect(rate("claude-fable-5", "cacheWrite1h")).toBeCloseTo(20, 6);
  });

  test("applies the 90% cached-input discount to the GPT-5.6 family", () => {
    expect(rate("gpt-5.6-terra", "cacheRead")).toBeCloseTo(0.2, 6);
    expect(rate("gpt-5.6-luna", "cacheRead")).toBeCloseTo(0.02, 6);
  });

  test("keeps Fable distinct from the Opus tier", () => {
    expect(rate("claude-fable-5", "input")).not.toBeCloseTo(rate("claude-opus-4-8", "input"), 6);
  });
});

describe("unpriced tracking", () => {
  test("records a genuinely unknown model", () => {
    cost({ ...EMPTY, input: 1 }, "some-future-model");
    expect(unpricedModels()).toContain("some-future-model");
  });

  test.each(["(unknown)", "unknown", "", "  "])(
    "does not report the %p placeholder as an unpriced model",
    (model) => {
      expect(cost({ ...EMPTY, input: MTOK }, model)).toBe(0);
      expect(unpricedModels()).not.toContain(model);
    },
  );
});
