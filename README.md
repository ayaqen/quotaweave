# QuotaWeave

QuotaWeave is a deterministic admission-control engine for multi-tenant systems. It decides **who may use shared capacity next** when work consumes several scarce resources at once: CPU, GPU time, memory, model tokens, database connections, or external API quota.

It is not another job queue. It sits in front of your existing workers or queue consumer and protects quiet tenants from noisy neighbors without leaving usable capacity idle.

## What makes it different

- **Multi-resource fairness:** schedules by dominant resource share instead of counting every job as equal.
- **Hierarchical policies:** enforce limits across an organization and every project below it.
- **Weighted service:** paid tiers or critical tenants can receive predictable relative shares.
- **Adaptive cost correction:** learns when a workload consistently consumes more or less than its estimate.
- **Deadline and age awareness:** urgent work advances while long-waiting work cannot starve forever.
- **Crash safety primitives:** expiring leases and monotonic fencing tokens prevent stale workers from settling newer work.
- **Stable horizontal routing:** weighted rendezvous hashing assigns tenants to scheduler shards with minimal movement.
- **Deterministic simulation:** replay a workload and inspect per-tenant dwell time before changing production policy.
- **Zero runtime dependencies:** the core uses only the Node.js standard library.

## Install

This package is published through GitHub Packages:

```ini
# .npmrc
@ayaqen:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

```bash
npm install @ayaqen/quotaweave
```

Node.js 20 or newer is required.

## Quick start

```ts
import { InMemoryQuotaGate } from "@ayaqen/quotaweave";

const gate = new InMemoryQuotaGate({
  resources: {
    gpuMs: { capacity: 8_000 },
    tokens: { capacity: 120_000 },
    databaseOps: { capacity: 500 }
  },
  policies: [
    { scope: "*", maxConcurrency: 200 },
    { scope: "acme", weight: 3, maxConcurrency: 40 },
    { scope: "acme/research", resourceLimits: { gpuMs: 4_000 } }
  ]
});

const lease = await gate.acquire({
  id: crypto.randomUUID(),
  idempotencyKey: "request-8391",
  tenant: "acme/research",
  workload: "llm-inference",
  priority: 20,
  deadline: Date.now() + 30_000,
  estimatedCost: {
    gpuMs: 850,
    tokens: 12_000,
    databaseOps: 8
  }
});

try {
  await runInference();
} finally {
  gate.settle(lease, {
    actualCost: { gpuMs: 734, tokens: 11_842, databaseOps: 7 }
  });
}
```

When capacity is unavailable, `acquire()` waits. Pass an `AbortSignal` to cancel queued work safely.

## Queue-adapter usage

Adapters can use the lower-level scheduler directly:

```ts
import { QuotaWeaveScheduler } from "@ayaqen/quotaweave";

const scheduler = new QuotaWeaveScheduler({
  resources: { cpu: { capacity: 32 }, memoryGb: { capacity: 128 } }
});

scheduler.enqueue({
  id: "job-1",
  tenant: "customer-a",
  workload: "report",
  estimatedCost: { cpu: 2, memoryGb: 4 }
});

for (const lease of scheduler.schedule(8)) {
  // Hand lease.item to BullMQ, Celery, Kafka, SQS, or your own worker.
  await dispatch(lease.item);
  scheduler.settle(lease.leaseId, lease.fencingToken);
}
```

Do not allow a worker to mutate external state unless its fencing token is still current. This is what prevents a delayed worker from acting after its lease has expired.

## Simulate policy changes

```ts
import { simulate } from "@ayaqen/quotaweave/simulator";

const result = simulate({
  scheduler: {
    resources: { gpu: { capacity: 2 } },
    policies: [{ scope: "enterprise", weight: 3 }]
  },
  workerLimit: 8,
  jobs: recordedTraffic
});

console.table(result.tenants);
```

The result includes mean, p95, and maximum queue dwell time by tenant plus a final Jain fairness index.

## Scaling model

QuotaWeave deliberately separates scheduling policy from transport:

```text
producers -> durable queue -> tenant router -> scheduler shard -> workers
                                    |                |
                              rendezvous hash    lease + fence
```

Use `RendezvousShardRouter` to keep a tenant hierarchy on one scheduler shard. Run one active scheduler leader per shard, store jobs in your durable queue, and replicate lease state through your chosen coordination layer. Capacity in each shard should represent only the workers assigned to that shard.

The included `InMemoryQuotaGate` is production-appropriate for a single process. It is **not distributed consensus**. A Redis or PostgreSQL adapter must make enqueue, admission, lease renewal, and settlement atomic before multiple scheduler processes may share one shard. See [docs/ADAPTERS.md](docs/ADAPTERS.md).

## Operational signals

`scheduler.snapshot()` reports:

- queued and active work
- utilization for every configured resource
- per-tenant active, completed, expired, and service totals
- virtual finish time
- Jain fairness index

Subscribe with `scheduler.onEvent()` to export admission, settlement, expiration, and cancellation events to OpenTelemetry or Prometheus. Listener failures are isolated from scheduler correctness.

## Guarantees and boundaries

QuotaWeave guarantees deterministic ordering for identical state and input, bounded capacity according to configured estimates, hierarchical policy enforcement, and monotonic fencing tokens within one scheduler instance.

It cannot guarantee exactly-once job execution, truthful cost reporting, distributed consensus, or global fairness across independently configured shards. Those properties require durable adapter semantics and correct worker integration.

## Development

```bash
npm ci
npm run check
npm run benchmark
```

The package uses Apache-2.0. See [SECURITY.md](SECURITY.md) before deploying it on an untrusted multi-tenant boundary.
