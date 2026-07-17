import { describe, expect, it } from "vitest";

import { SimulationDeadlockError, simulate, type SimulationJob } from "../src/index.js";

describe("simulate", () => {
  it("demonstrates quiet-tenant protection under a noisy-neighbor burst", () => {
    const jobs: SimulationJob[] = [];
    for (let index = 0; index < 10; index += 1) {
      jobs.push({
        item: {
          id: `noisy-${index}`,
          tenant: "noisy",
          workload: "report",
          estimatedCost: { cpu: 1 },
        },
        arrivalAt: 0,
        durationMs: 100,
      });
    }
    jobs.push({
      item: {
        id: "quiet-0",
        tenant: "quiet",
        workload: "report",
        estimatedCost: { cpu: 1 },
      },
      arrivalAt: 0,
      durationMs: 100,
    });

    const result = simulate({
      scheduler: { resources: { cpu: { capacity: 1 } } },
      jobs,
      workerLimit: 1,
    });

    const quiet = result.records.find((record) => record.tenant === "quiet");
    expect(quiet?.dwellTimeMs).toBeLessThanOrEqual(100);
    expect(result.records).toHaveLength(11);
    expect(result.snapshot.completed).toBe(11);
  });

  it("reports an impossible resource request as a deadlock", () => {
    expect(() => simulate({
      scheduler: { resources: { gpu: { capacity: 1 } } },
      jobs: [{
        item: {
          id: "oversized",
          tenant: "tenant",
          workload: "train",
          estimatedCost: { gpu: 2 },
        },
        arrivalAt: 0,
        durationMs: 1,
      }],
    })).toThrow(SimulationDeadlockError);
  });

  it("returns a valid empty result", () => {
    const result = simulate({
      scheduler: { resources: { cpu: { capacity: 1 } } },
      jobs: [],
    });
    expect(result).toMatchObject({ startedAt: 0, completedAt: 0, records: [], tenants: [] });
  });
});
