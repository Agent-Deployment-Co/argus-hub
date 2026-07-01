import { describe, expect, test } from "bun:test";
import { classifyOutcome } from "../src/api/task-list.ts";

describe("classifyOutcome", () => {
  test("classifies positive outcomes as success", () => {
    expect(classifyOutcome("Success")).toBe("success");
    expect(classifyOutcome("Completed the task")).toBe("success");
    expect(classifyOutcome("done")).toBe("success");
    expect(classifyOutcome("Resolved")).toBe("success");
  });

  test("classifies negative outcomes as failure", () => {
    expect(classifyOutcome("Failed")).toBe("failure");
    expect(classifyOutcome("Abandoned")).toBe("failure");
    expect(classifyOutcome("Blocked")).toBe("failure");
  });

  test("never classifies negated positive keywords as success", () => {
    expect(classifyOutcome("Unsuccessful")).not.toBe("success");
    expect(classifyOutcome("Incomplete")).not.toBe("success");
    expect(classifyOutcome("Unresolved")).not.toBe("success");
    expect(classifyOutcome("Not resolved")).not.toBe("success");
  });

  test("returns unknown for empty or unrecognized outcomes", () => {
    expect(classifyOutcome(undefined)).toBe("unknown");
    expect(classifyOutcome("")).toBe("unknown");
    expect(classifyOutcome("in progress")).toBe("unknown");
  });
});
