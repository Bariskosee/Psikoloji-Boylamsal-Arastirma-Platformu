import { describe, expect, it } from "vitest";
import { assignDisplayOrder, planReorder } from "./reorder.js";

describe("planReorder", () => {
  it("accepts a permutation of the current ids", () => {
    const result = planReorder(["a", "b", "c"], ["c", "a", "b"]);
    expect(result).toEqual({ ok: true, order: ["c", "a", "b"] });
  });

  it("accepts the identity order, so re-applying the same order is a no-op", () => {
    const result = planReorder(["a", "b", "c"], ["a", "b", "c"]);
    expect(result.ok).toBe(true);
    expect(result.order).toEqual(["a", "b", "c"]);
  });

  it("rejects a shorter list", () => {
    expect(planReorder(["a", "b", "c"], ["a", "b"])).toEqual({
      ok: false,
      reason: "COUNT_MISMATCH",
    });
  });

  it("rejects a longer list", () => {
    expect(planReorder(["a", "b"], ["a", "b", "c"])).toEqual({
      ok: false,
      reason: "COUNT_MISMATCH",
    });
  });

  it("rejects a duplicate id even at the same total count", () => {
    expect(planReorder(["a", "b", "c"], ["a", "a", "c"])).toEqual({
      ok: false,
      reason: "DUPLICATE_ID",
    });
  });

  it("rejects an id that does not belong to the current set", () => {
    expect(planReorder(["a", "b", "c"], ["a", "b", "z"])).toEqual({
      ok: false,
      reason: "UNKNOWN_ID",
    });
  });

  it("handles the empty case", () => {
    expect(planReorder([], [])).toEqual({ ok: true, order: [] });
  });
});

describe("assignDisplayOrder", () => {
  it("assigns contiguous zero-based positions in the given order", () => {
    expect(assignDisplayOrder(["x", "y", "z"])).toEqual([
      { id: "x", displayOrder: 0 },
      { id: "y", displayOrder: 1 },
      { id: "z", displayOrder: 2 },
    ]);
  });

  it("is idempotent: applying it twice to the same order yields the same result", () => {
    const order = ["p", "q"];
    expect(assignDisplayOrder(order)).toEqual(assignDisplayOrder(order));
  });
});
