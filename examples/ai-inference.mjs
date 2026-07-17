import { InMemoryQuotaGate } from "../dist/index.js";

const gate = new InMemoryQuotaGate({
  resources: {
    gpu: { capacity: 2 },
    tokens: { capacity: 50_000 }
  },
  policies: [
    { scope: "*", maxConcurrency: 20 },
    { scope: "enterprise", weight: 3 }
  ]
});

async function run(id, tenant, tokens) {
  const lease = await gate.acquire({
    id,
    tenant,
    workload: "inference",
    estimatedCost: { gpu: 1, tokens }
  });

  await new Promise((resolve) => setTimeout(resolve, 10));
  gate.settle(lease, { actualCost: { gpu: 1, tokens: Math.floor(tokens * 0.95) } });
  return `${id} completed with fence ${lease.fencingToken}`;
}

console.log(await Promise.all([
  run("free-1", "free", 10_000),
  run("enterprise-1", "enterprise", 10_000),
  run("enterprise-2", "enterprise", 10_000)
]));
console.log(gate.snapshot());
