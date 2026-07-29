import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { classifyTasksForLabel, parseClassifyVerdict } from "../src/llm/classify-label.ts";
import type { TaskLabelRef } from "../src/store/hub-store.ts";

interface Fixture {
  labels: Array<{ name: string; description: string }>;
  tasks: Array<{ description: string; expectedLabel: string | null; ambiguousWith?: string; note?: string }>;
}

const fixture: Fixture = JSON.parse(
  readFileSync(join(import.meta.dir, "fixtures/label-classification.json"), "utf8"),
);

function ref(i: number): TaskLabelRef {
  return { clientId: "client-fixture", sessionId: "sess-fixture", taskSeq: i };
}

describe("parseClassifyVerdict", () => {
  test("parses a yes/no verdict with a reason", () => {
    expect(parseClassifyVerdict("yes: matches the bug fix pattern")).toEqual({
      matched: true, reasoning: "matches the bug fix pattern",
    });
    expect(parseClassifyVerdict("no: this is a planning task")).toEqual({
      matched: false, reasoning: "this is a planning task",
    });
  });

  test("is case-insensitive and tolerates surrounding whitespace", () => {
    expect(parseClassifyVerdict("  YES:  because reasons  \n")).toEqual({
      matched: true, reasoning: "because reasons",
    });
  });

  test("falls back to a bare yes/no with no reason", () => {
    expect(parseClassifyVerdict("no")).toEqual({ matched: false, reasoning: undefined });
    expect(parseClassifyVerdict("yes")).toEqual({ matched: true, reasoning: undefined });
  });

  test("treats unparseable text as no-match with an explanatory reason", () => {
    const result = parseClassifyVerdict("I'm not sure, could be either");
    expect(result.matched).toBe(false);
    expect(result.reasoning).toContain("Unparseable classifier reply");
  });

  test("treats an empty reply as no-match", () => {
    expect(parseClassifyVerdict("   ")).toEqual({ matched: false, reasoning: "Empty classifier reply" });
  });
});

describe("classifyTasksForLabel", () => {
  test("classifies every fixture task against each fixture label via a stubbed provider", async () => {
    for (const label of fixture.labels) {
      const tasks = fixture.tasks.map((t, i) => ({ ref: ref(i), description: t.description }));

      // Stub provider: "perfectly" classifies by checking whether the task's fixture-declared
      // expectedLabel matches the label under test. This exercises classifyTasksForLabel's
      // request/response plumbing and verdict parsing, not real model judgment quality — the
      // fixture's ambiguous/negative cases exist for manual review-wizard verification (see
      // AUTO_LABEL_PLAN.md), not to assert a single correct answer here.
      const results = await classifyTasksForLabel(
        { name: label.name, description: label.description },
        tasks,
        { provider: "command", command: "fake-classifier" },
        {
          executeCommand: async (_command, input) => {
            const task = fixture.tasks.find((t) => input.includes(`Task: ${t.description}`));
            const matched = task?.expectedLabel === label.name;
            return { ok: true, text: matched ? `yes: matches ${label.name}` : `no: does not match ${label.name}` };
          },
        },
      );

      expect(results).toHaveLength(fixture.tasks.length);
      for (const [i, result] of results.entries()) {
        const expected = fixture.tasks[i]!.expectedLabel === label.name;
        expect(result.matched).toBe(expected);
        expect(result.ref).toEqual(ref(i));
        expect(result.reasoning).toContain(label.name);
      }
    }
  });

  test("degrades a single failed task to matched:false without throwing", async () => {
    const tasks = [
      { ref: ref(0), description: "Fix is_hidden flag materialization bug" },
      { ref: ref(1), description: "Refill the office coffee machine" },
    ];

    const results = await classifyTasksForLabel(
      { name: "Bug Fix", description: "Diagnosing and correcting a defect." },
      tasks,
      { provider: "command", command: "fake-classifier" },
      {
        executeCommand: async (_command, input) => {
          if (input.includes("coffee machine")) return { ok: false, text: "", error: "classifier timed out" };
          return { ok: true, text: "yes: fixes a bug" };
        },
      },
    );

    expect(results[0]).toEqual({ ref: ref(0), matched: true, reasoning: "fixes a bug" });
    expect(results[1]!.matched).toBe(false);
    // sanitizeLlmError intentionally redacts the raw error for the "command" provider
    // (src/llm/resolve.ts) — just confirm the failure surfaced as a reasoning string.
    expect(results[1]!.reasoning).toContain("command failed");
  });

  test("degrades a malformed reply to matched:false with the raw text surfaced", async () => {
    const tasks = [{ ref: ref(0), description: "Fix is_hidden flag materialization bug" }];

    const results = await classifyTasksForLabel(
      { name: "Bug Fix", description: "Diagnosing and correcting a defect." },
      tasks,
      { provider: "command", command: "fake-classifier" },
      { executeCommand: async () => ({ ok: true, text: "maybe? hard to say" }) },
    );

    expect(results[0]!.matched).toBe(false);
    expect(results[0]!.reasoning).toContain("Unparseable classifier reply");
  });
});
