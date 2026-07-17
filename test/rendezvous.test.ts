import { describe, expect, it } from "vitest";

import { RendezvousShardRouter } from "../src/index.js";

describe("RendezvousShardRouter", () => {
  it("routes deterministically and distributes tenants", () => {
    const router = new RendezvousShardRouter([{ id: "a" }, { id: "b" }, { id: "c" }]);
    expect(router.route("acme/research")).toBe(router.route("acme/research"));
    const distribution = router.distribution(
      Array.from({ length: 1_000 }, (_, index) => `tenant-${index}`),
    );
    expect(distribution.a).toBeGreaterThan(250);
    expect(distribution.b).toBeGreaterThan(250);
    expect(distribution.c).toBeGreaterThan(250);
  });

  it("honors relative shard weights", () => {
    const router = new RendezvousShardRouter([{ id: "small", weight: 1 }, { id: "large", weight: 3 }]);
    const distribution = router.distribution(
      Array.from({ length: 2_000 }, (_, index) => `tenant-${index}`),
    );
    expect(distribution.large ?? 0).toBeGreaterThan((distribution.small ?? 0) * 2.5);
  });
});
