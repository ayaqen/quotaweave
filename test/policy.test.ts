import { describe, expect, it } from "vitest";

import { ConfigurationError, PolicyResolver, scopeMatches } from "../src/index.js";

describe("PolicyResolver", () => {
  it("inherits broad controls and lets specific weights override", () => {
    const resolver = new PolicyResolver(
      [
        { scope: "*", weight: 1, maxConcurrency: 20, resourceLimits: { cpu: 90 } },
        { scope: "acme", weight: 2, maxConcurrency: 10, resourceLimits: { cpu: 40 } },
        { scope: "acme/research", weight: 5, maxConcurrency: 4 },
      ],
      { cpu: { capacity: 100 } },
    );

    expect(resolver.resolve("acme/research/vision")).toEqual({
      weight: 5,
      maxConcurrency: 4,
      resourceLimits: { cpu: 40 },
      matchedScopes: ["*", "acme", "acme/research"],
    });
  });

  it("validates duplicate scopes and unknown resources", () => {
    expect(() => new PolicyResolver(
      [{ scope: "acme" }, { scope: "acme" }],
      { cpu: { capacity: 1 } },
    )).toThrow(ConfigurationError);
    expect(() => new PolicyResolver(
      [{ scope: "acme", resourceLimits: { gpu: 1 } }],
      { cpu: { capacity: 1 } },
    )).toThrow(ConfigurationError);
  });

  it("matches tenant descendants without prefix collisions", () => {
    expect(scopeMatches("acme", "acme/research")).toBe(true);
    expect(scopeMatches("acme", "acme-corp")).toBe(false);
    expect(scopeMatches("*", "any/tenant")).toBe(true);
  });
});
