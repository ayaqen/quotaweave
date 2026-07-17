import { describe, expect, it } from "vitest";

import { jainFairnessIndex } from "../src/index.js";

describe("jainFairnessIndex", () => {
  it("is one for equal service and lower for imbalance", () => {
    expect(jainFairnessIndex([10, 10, 10])).toBe(1);
    expect(jainFairnessIndex([30, 0, 0])).toBeCloseTo(1 / 3);
  });

  it("handles empty and zero-only observations", () => {
    expect(jainFairnessIndex([])).toBe(1);
    expect(jainFairnessIndex([0, 0])).toBe(1);
  });
});
