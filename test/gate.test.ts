import { describe, expect, it } from "vitest";

import { InMemoryQuotaGate } from "../src/index.js";

describe("InMemoryQuotaGate", () => {
  it("blocks work until capacity is released", async () => {
    const gate = new InMemoryQuotaGate({ resources: { gpu: { capacity: 1 } } });
    const first = await gate.acquire({
      id: "first",
      tenant: "a",
      workload: "inference",
      estimatedCost: { gpu: 1 },
    });

    let secondResolved = false;
    const secondPromise = gate.acquire({
      id: "second",
      tenant: "b",
      workload: "inference",
      estimatedCost: { gpu: 1 },
    }).then((lease) => {
      secondResolved = true;
      return lease;
    });
    await Promise.resolve();
    expect(secondResolved).toBe(false);

    gate.settle(first);
    const second = await secondPromise;
    expect(second.item.id).toBe("second");
    gate.settle(second);
  });

  it("cancels queued acquisition with an AbortSignal", async () => {
    const gate = new InMemoryQuotaGate({ resources: { cpu: { capacity: 1 } } });
    const active = await gate.acquire({
      id: "active",
      tenant: "a",
      workload: "task",
      estimatedCost: { cpu: 1 },
    });
    const controller = new AbortController();
    const waiting = gate.acquire({
      id: "waiting",
      tenant: "b",
      workload: "task",
      estimatedCost: { cpu: 1 },
    }, controller.signal);
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    expect(gate.snapshot().queued).toBe(0);
    gate.settle(active);
  });
});
