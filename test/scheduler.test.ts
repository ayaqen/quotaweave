import { describe, expect, it, vi } from "vitest";

import {
  DuplicateWorkItemError,
  QuotaWeaveScheduler,
  StaleFencingTokenError,
  UnknownLeaseError,
  type WorkItem,
} from "../src/index.js";

function item(id: string, tenant: string, cpu = 1): WorkItem {
  return {
    id,
    tenant,
    workload: "render",
    estimatedCost: { cpu },
  };
}

describe("QuotaWeaveScheduler", () => {
  it("provides weighted service while preserving progress for every tenant", () => {
    const scheduler = new QuotaWeaveScheduler({
      resources: { cpu: { capacity: 1 } },
      policies: [
        { scope: "basic", weight: 1 },
        { scope: "priority", weight: 3 },
      ],
    });

    for (let index = 0; index < 30; index += 1) {
      scheduler.enqueue(item(`basic-${index}`, "basic"));
      scheduler.enqueue(item(`priority-${index}`, "priority"));
    }

    const firstTwenty: string[] = [];
    for (let index = 0; index < 20; index += 1) {
      const lease = scheduler.schedule()[0];
      expect(lease).toBeDefined();
      if (lease === undefined) break;
      firstTwenty.push(lease.item.tenant);
      scheduler.settle(lease.leaseId, lease.fencingToken);
    }

    const priorityCount = firstTwenty.filter((tenant) => tenant === "priority").length;
    expect(priorityCount).toBeGreaterThanOrEqual(14);
    expect(priorityCount).toBeLessThanOrEqual(16);
    expect(firstTwenty).toContain("basic");
  });

  it("enforces hierarchical concurrency and resource ceilings", () => {
    const scheduler = new QuotaWeaveScheduler({
      resources: { cpu: { capacity: 16 }, memory: { capacity: 64 } },
      policies: [
        { scope: "*", maxConcurrency: 4 },
        { scope: "acme", maxConcurrency: 2, resourceLimits: { cpu: 5 } },
      ],
    });

    scheduler.enqueue({ ...item("a", "acme/analytics", 2), estimatedCost: { cpu: 2, memory: 4 } });
    scheduler.enqueue({ ...item("b", "acme/research", 2), estimatedCost: { cpu: 2, memory: 4 } });
    scheduler.enqueue({ ...item("c", "acme/research", 2), estimatedCost: { cpu: 2, memory: 4 } });
    scheduler.enqueue({ ...item("d", "other", 2), estimatedCost: { cpu: 2, memory: 4 } });

    const leases = scheduler.schedule(10);
    expect(leases).toHaveLength(3);
    expect(leases.filter((lease) => lease.item.tenant.startsWith("acme"))).toHaveLength(2);
    expect(scheduler.snapshot().resources.cpu?.used).toBe(6);
  });

  it("learns systematic cost underestimation from settlements", () => {
    const scheduler = new QuotaWeaveScheduler({
      resources: { gpu: { capacity: 10 } },
      tuning: { costLearningRate: 0.5 },
    });
    scheduler.enqueue({
      id: "first",
      tenant: "acme",
      workload: "embedding",
      estimatedCost: { gpu: 2 },
    });
    const lease = scheduler.schedule()[0];
    expect(lease).toBeDefined();
    if (lease === undefined) return;
    scheduler.settle(lease.leaseId, lease.fencingToken, { actualCost: { gpu: 4 } });

    expect(scheduler.predict("embedding", { gpu: 2 }).gpu).toBeCloseTo(3);
  });

  it("reclaims expired leases and rejects stale or unknown fencing tokens", () => {
    let now = 1_000;
    const scheduler = new QuotaWeaveScheduler({
      resources: { cpu: { capacity: 1 } },
      tuning: { leaseTtlMs: 100 },
      clock: () => now,
    });
    scheduler.enqueue(item("a", "tenant"));
    const lease = scheduler.schedule()[0];
    expect(lease).toBeDefined();
    if (lease === undefined) return;

    expect(() => scheduler.settle(lease.leaseId, lease.fencingToken + 1)).toThrow(StaleFencingTokenError);
    now = 1_101;
    expect(scheduler.sweepExpired()).toHaveLength(1);
    expect(scheduler.snapshot()).toMatchObject({ active: 0, expired: 1 });
    expect(() => scheduler.settle(lease.leaseId, lease.fencingToken)).toThrow(UnknownLeaseError);
  });

  it("renews leases without changing their fencing token", () => {
    let now = 10;
    const scheduler = new QuotaWeaveScheduler({
      resources: { cpu: { capacity: 1 } },
      tuning: { leaseTtlMs: 20 },
      clock: () => now,
    });
    scheduler.enqueue(item("a", "tenant"));
    const lease = scheduler.schedule()[0];
    expect(lease).toBeDefined();
    if (lease === undefined) return;
    now = 25;
    const renewed = scheduler.renew(lease.leaseId, lease.fencingToken, 50);
    expect(renewed.expiresAt).toBe(75);
    expect(renewed.fencingToken).toBe(lease.fencingToken);
    now = 40;
    expect(scheduler.sweepExpired()).toHaveLength(0);
  });

  it("protects idempotency keys and supports cancellation", () => {
    const scheduler = new QuotaWeaveScheduler({ resources: { cpu: { capacity: 1 } } });
    scheduler.enqueue({ ...item("a", "tenant"), idempotencyKey: "request-7" });
    expect(() => scheduler.enqueue({ ...item("b", "tenant"), idempotencyKey: "request-7" }))
      .toThrow(DuplicateWorkItemError);
    expect(scheduler.cancel("a")?.id).toBe("a");
    expect(scheduler.snapshot().queued).toBe(0);
  });

  it("isolates scheduler correctness from failing event listeners", () => {
    const scheduler = new QuotaWeaveScheduler({ resources: { cpu: { capacity: 1 } } });
    const listener = vi.fn(() => {
      throw new Error("telemetry unavailable");
    });
    scheduler.onEvent(listener);
    expect(() => scheduler.enqueue(item("a", "tenant"))).not.toThrow();
    expect(scheduler.schedule()).toHaveLength(1);
    expect(listener).toHaveBeenCalled();
  });
});
