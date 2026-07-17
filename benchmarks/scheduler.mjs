import { performance } from "node:perf_hooks";

import { QuotaWeaveScheduler } from "../dist/index.js";

const tenants = 100;
const jobsPerTenant = 100;
const totalJobs = tenants * jobsPerTenant;
const scheduler = new QuotaWeaveScheduler({
  resources: {
    cpu: { capacity: 64 },
    memory: { capacity: 256 },
    io: { capacity: 1_000 }
  },
  policies: [{ scope: "*", maxConcurrency: 1_000 }]
});

for (let tenant = 0; tenant < tenants; tenant += 1) {
  for (let job = 0; job < jobsPerTenant; job += 1) {
    scheduler.enqueue({
      id: `${tenant}-${job}`,
      tenant: `tenant-${tenant}`,
      workload: "benchmark",
      estimatedCost: { cpu: 1, memory: 1, io: 1 }
    });
  }
}

const started = performance.now();
let completed = 0;
while (completed < totalJobs) {
  const leases = scheduler.schedule(64);
  if (leases.length === 0) throw new Error("Benchmark scheduler made no progress.");
  for (const lease of leases) {
    scheduler.settle(lease.leaseId, lease.fencingToken);
    completed += 1;
  }
}
const elapsedMs = performance.now() - started;
const decisionsPerSecond = totalJobs / (elapsedMs / 1_000);

console.log(JSON.stringify({
  tenants,
  jobs: totalJobs,
  elapsedMs: Number(elapsedMs.toFixed(2)),
  decisionsPerSecond: Math.round(decisionsPerSecond)
}, null, 2));
