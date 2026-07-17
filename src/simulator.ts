import { SimulationDeadlockError } from "./errors.js";
import { QuotaWeaveScheduler } from "./scheduler.js";
import type {
  ResourceVector,
  ScheduledLease,
  SchedulerOptions,
  SchedulerSnapshot,
  WorkItem,
} from "./types.js";

export interface SimulationJob<TPayload = unknown> {
  readonly item: WorkItem<TPayload>;
  readonly arrivalAt: number;
  readonly durationMs: number;
  readonly actualCost?: ResourceVector;
}

export interface SimulationOptions<TPayload = unknown> {
  readonly scheduler: Omit<SchedulerOptions, "clock">;
  readonly jobs: readonly SimulationJob<TPayload>[];
  readonly workerLimit?: number;
}

export interface SimulationRecord {
  readonly itemId: string;
  readonly tenant: string;
  readonly arrivalAt: number;
  readonly admittedAt: number;
  readonly completedAt: number;
  readonly dwellTimeMs: number;
  readonly durationMs: number;
  readonly fencingToken: number;
}

export interface TenantSimulationSummary {
  readonly tenant: string;
  readonly completed: number;
  readonly meanDwellTimeMs: number;
  readonly p95DwellTimeMs: number;
  readonly maximumDwellTimeMs: number;
}

export interface SimulationResult {
  readonly startedAt: number;
  readonly completedAt: number;
  readonly records: readonly SimulationRecord[];
  readonly tenants: readonly TenantSimulationSummary[];
  readonly snapshot: SchedulerSnapshot;
}

interface RunningJob<TPayload> {
  readonly lease: ScheduledLease<TPayload>;
  readonly source: SimulationJob<TPayload>;
  readonly completesAt: number;
}

export function simulate<TPayload = unknown>(options: SimulationOptions<TPayload>): SimulationResult {
  const jobs = [...options.jobs].sort(
    (left, right) => left.arrivalAt - right.arrivalAt || left.item.id.localeCompare(right.item.id),
  );
  if (jobs.length === 0) {
    const scheduler = new QuotaWeaveScheduler<TPayload>({ ...options.scheduler, clock: () => 0 });
    return { startedAt: 0, completedAt: 0, records: [], tenants: [], snapshot: scheduler.snapshot() };
  }

  const workerLimit = options.workerLimit ?? Number.POSITIVE_INFINITY;
  if (!(workerLimit === Number.POSITIVE_INFINITY || (Number.isSafeInteger(workerLimit) && workerLimit > 0))) {
    throw new RangeError("workerLimit must be a positive integer or Infinity.");
  }
  for (const job of jobs) validateSimulationJob(job);

  const sourceById = new Map(jobs.map((job) => [job.item.id, job]));
  let now = jobs[0]?.arrivalAt ?? 0;
  const startedAt = now;
  const scheduler = new QuotaWeaveScheduler<TPayload>({ ...options.scheduler, clock: () => now });
  const running = new Map<string, RunningJob<TPayload>>();
  const records: SimulationRecord[] = [];
  let pendingIndex = 0;

  while (pendingIndex < jobs.length || running.size > 0 || scheduler.snapshot().queued > 0) {
    while (pendingIndex < jobs.length) {
      const job = jobs[pendingIndex];
      if (job === undefined || job.arrivalAt > now) break;
      scheduler.enqueue({ ...job.item, createdAt: job.arrivalAt });
      pendingIndex += 1;
    }

    for (const active of [...running.values()]) {
      if (active.completesAt > now) continue;
      scheduler.settle(active.lease.leaseId, active.lease.fencingToken, {
        actualCost: active.source.actualCost ?? active.lease.admittedCost,
        completedAt: now,
      });
      running.delete(active.lease.leaseId);
      records.push({
        itemId: active.lease.item.id,
        tenant: active.lease.item.tenant,
        arrivalAt: active.source.arrivalAt,
        admittedAt: active.lease.acquiredAt,
        completedAt: now,
        dwellTimeMs: active.lease.acquiredAt - active.source.arrivalAt,
        durationMs: active.source.durationMs,
        fencingToken: active.lease.fencingToken,
      });
    }

    const availableWorkers = workerLimit === Number.POSITIVE_INFINITY
      ? Math.max(1, scheduler.snapshot().queued)
      : Math.max(0, workerLimit - running.size);
    if (availableWorkers > 0) {
      for (const lease of scheduler.schedule(availableWorkers, now)) {
        const source = sourceById.get(lease.item.id);
        if (source === undefined) throw new Error(`Missing simulation source for '${lease.item.id}'.`);
        running.set(lease.leaseId, {
          lease,
          source,
          completesAt: now + source.durationMs,
        });
      }
    }

    const nextArrival = jobs[pendingIndex]?.arrivalAt ?? Number.POSITIVE_INFINITY;
    const nextCompletion = Math.min(
      ...[...running.values()].map((active) => active.completesAt),
      Number.POSITIVE_INFINITY,
    );

    if (nextArrival === Number.POSITIVE_INFINITY && nextCompletion === Number.POSITIVE_INFINITY) {
      const queued = scheduler.snapshot().queued;
      if (queued > 0) {
        throw new SimulationDeadlockError(
          `${queued} queued work item(s) cannot fit the configured resources or tenant policies.`,
        );
      }
      break;
    }

    const next = Math.min(nextArrival, nextCompletion);
    now = next > now ? next : now + 1;
  }

  records.sort((left, right) => left.completedAt - right.completedAt || left.itemId.localeCompare(right.itemId));
  return {
    startedAt,
    completedAt: now,
    records,
    tenants: summarizeTenants(records),
    snapshot: scheduler.snapshot(),
  };
}

function summarizeTenants(records: readonly SimulationRecord[]): readonly TenantSimulationSummary[] {
  const tenants = new Map<string, number[]>();
  for (const record of records) {
    const dwellTimes = tenants.get(record.tenant) ?? [];
    dwellTimes.push(record.dwellTimeMs);
    tenants.set(record.tenant, dwellTimes);
  }

  return [...tenants.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([tenant, dwellTimes]) => {
      const sorted = [...dwellTimes].sort((left, right) => left - right);
      const p95Index = Math.max(0, Math.ceil(sorted.length * 0.95) - 1);
      return {
        tenant,
        completed: sorted.length,
        meanDwellTimeMs: sorted.reduce((total, dwell) => total + dwell, 0) / sorted.length,
        p95DwellTimeMs: sorted[p95Index] ?? 0,
        maximumDwellTimeMs: sorted.at(-1) ?? 0,
      };
    });
}

function validateSimulationJob<TPayload>(job: SimulationJob<TPayload>): void {
  if (!Number.isFinite(job.arrivalAt)) throw new RangeError("Simulation arrivalAt must be finite.");
  if (!Number.isFinite(job.durationMs) || job.durationMs < 0) {
    throw new RangeError("Simulation durationMs must be finite and non-negative.");
  }
}
