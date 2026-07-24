import { describe, expect, test } from "bun:test";
import {
  parseClassifierOutput,
  searchCandidates,
  type ClassifyTaskInput,
} from "../src/classify/task-labeler.ts";

const tasks: ClassifyTaskInput[] = [
  { ref: "task-1", description: "Fix a bug" },
  { ref: "task-2", description: "Write docs" },
];

describe("provider-neutral task labeler", () => {
  test("rejects malformed, duplicate, and unknown references", () => {
    expect(parseClassifierOutput("not json", tasks)).toEqual([]);
    expect(parseClassifierOutput(JSON.stringify({
      matches: [
        { ref: "unknown", match: true, reason: "bad" },
        { ref: "task-1", match: "yes", reason: "bad" },
        { ref: "task-1", match: true, reason: "valid" },
        { ref: "task-1", match: false, reason: "duplicate" },
      ],
    }), tasks)).toEqual([{ ref: "task-1", match: true, reason: "valid" }]);
  });

  test("batches inputs and omits references the provider did not validate", async () => {
    const many = Array.from({ length: 45 }, (_, index) => ({
      ref: `task-${index}`,
      description: `Task ${index}`,
    }));
    const batchSizes: number[] = [];
    const results = await searchCandidates("Test", "Test tasks", many, async (_name, _description, batch) => {
      batchSizes.push(batch.length);
      return batch.map((task) => ({ ref: task.ref, match: true, reason: "match" }));
    });
    expect(batchSizes.sort((a, b) => b - a)).toEqual([20, 20, 5]);
    expect(results).toHaveLength(45);
  });
});
