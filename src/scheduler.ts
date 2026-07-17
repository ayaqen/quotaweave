import { AdaptiveCostModel } from "./cost-model.js";
import {
  DuplicateWorkItemError,
  InvalidWorkItemError,
  StaleFencingTokenError,
  UnknownLeaseError,
} from "./errors.js";
import { jainFairnessIndex } from "./fairness.js";
import { PolicyResolver } from "./policy.js";
import type {
  ResourceVector,
  ScheduledLease,
  SchedulerEvent,
  SchedulerEventListener,
  SchedulerOptions,
  SchedulerSnapshot,
  Settlement,
  TenantSnapshot,
  WorkItem,
} from "./types.js";
import {
  addInto,
  configuredCapacity,
  dominantShare,
  fits,
  subtractFrom,
  validateCatalog,
  validateCost,
  zeroVector,
} from "./vector.js";

interface QueuedItem<TPayload> {
  readonly item: WorkItem<TPayload>;
  readonly sequence: number;
}

interface TenantState {
  virtualFinish: number;
  active: number;
  completed: number;
  expired: number;
  service: number;
}

interface Candidate<TPayload> {
  readonly queued: QueuedItem<TPayload>;
  readonly queueIndex: number;
  readonly admittedCost: ResourceVector;
  readonly score: number;
  readonly virtualFinish: number;
}

interface ActiveLease<TPayload> {
  readonly lease: ScheduledLease<TPayload>;
}

interface ScopeConsumption {
  active: number;
  readonly resources: Record<string, number>;
}

interface NormalizedTuning {
  readonly leaseTtlMs: number;
  readonly agingHalfLifeMs: number;
  readonly deadlineHorizonMs: number;
  readonly costLearningRate: number;
  readonly costMultiplierRange: readonly [number, number];
}

const DEFAULT_TUNING: NormalizedTuning = {
  leaseTtlMs: 30_000,
  agingHalfLifeMs: 60_000,
  deadlineHorizonMs: 30_000,
  costLearningRate: 0.2,
  costMultiplierRange: [0.25, 4],
};

export class QuotaWeaveScheduler<TPayload = unknown> {
  readonly #options: SchedulerOptions;
  readonly #tuning: NormalizedTuning;
  readonly #clock: () => number;
  readonly #policyResolver: PolicyResolver;
  readonly #costModel: AdaptiveCostModel;
  readonly #queues = new Map<string, QueuedItem<TPayload>[]>();
  readonly #tenants = new Map<string, TenantState>();
  readonly #active = new Map<string, ActiveLease<TPayload>>();
  readonly #scopeConsumption = new Map<string, ScopeConsumption>();
  readonly #globalUsage: Record<string, number>;
  readonly #capacity: Record<string, number>;
  readonly #knownIds = new Set<string>();
  readonly #idempotencyKeys = new Map<string, string>();
  readonly #listeners = new Set<SchedulerEventListener<TPayload>>();
  #sequence = 0;
  #fencingToken = 0;
  #virtualClock = 0;
  #completed = 0;
  #expired = 0;

  public constructor(options: SchedulerOptions) {
    validateCatalog(options.resources);
    this.#options = options;
    this.#tuning = normalizeTuning(options);
    this.#clock = options.clock ?? Date.now;
    this.#policyResolver = new PolicyResolver(options.policies ?? [], options.resources);
    this.#costModel = new AdaptiveCostModel(options.resources, {
      learningRate: this.#tuning.costLearningRate,
      multiplierRange: this.#tuning.costMultiplierRange,
    });
    this.#globalUsage = zeroVector(options.resources);
    this.#capacity = configuredCapacity(options.resources);
  }

  public enqueue(item: WorkItem<TPayload>): void {
    const now = this.#clock();
    this.#validateItem(item, now);

    if (this.#knownIds.has(item.id)) {
      throw new DuplicateWorkItemError(`Work item '${item.id}' is already queued or active.`);
    }
    if (item.idempotencyKey !== undefined) {
      const existing = this.#idempotencyKeys.get(item.idempotencyKey);
      if (existing !== undefined) {
        throw new DuplicateWorkItemError(
          `Idempotency key '${item.idempotencyKey}' was already used by '${existing}'.`,
        );
      }
      this.#idempotencyKeys.set(item.idempotencyKey, item.id);
    }

    const normalized: WorkItem<TPayload> = {
      ...item,
      createdAt: item.createdAt ?? now,
      priority: item.priority ?? 0,
    };
    const queue = this.#queues.get(item.tenant) ?? [];
    queue.push({ item: normalized, sequence: ++this.#sequence });
    queue.sort(compareQueuedItems);
    this.#queues.set(item.tenant, queue);
    this.#knownIds.add(item.id);
    this.#state(item.tenant);
    this.#emit({ type: "enqueued", item: normalized });
  }

  public schedule(maximum = 1, now = this.#clock()): readonly ScheduledLease<TPayload>[] {
    if (!Number.isSafeInteger(maximum) || maximum < 1) {
      throw new RangeError("maximum must be a positive integer.");
    }
    this.sweepExpired(now);

    const leases: ScheduledLease<TPayload>[] = [];
    for (let index = 0; index < maximum; index += 1) {
      const candidate = this.#chooseCandidate(now);
      if (candidate === undefined) break;
      leases.push(this.#admit(candidate, now));
    }
    return leases;
  }

  public settle(leaseId: string, fencingToken: number, settlement: Settlement = {}): ScheduledLease<TPayload> {
    const active = this.#assertLease(leaseId, fencingToken);
    const actualCost = settlement.actualCost ?? active.lease.admittedCost;
    validateCost(actualCost, this.#options.resources, "Actual cost");
    this.#release(active.lease, "settled", actualCost);
    this.#costModel.observe(
      active.lease.item.workload,
      active.lease.item.estimatedCost,
      actualCost,
    );

    const state = this.#state(active.lease.item.tenant);
    state.completed += 1;
    state.service += dominantShare(actualCost, this.#options.resources);
    this.#completed += 1;
    this.#emit({ type: "settled", lease: active.lease, actualCost });
    return active.lease;
  }

  public renew(
    leaseId: string,
    fencingToken: number,
    extensionMs = this.#tuning.leaseTtlMs,
    now = this.#clock(),
  ): ScheduledLease<TPayload> {
    if (!Number.isFinite(extensionMs) || extensionMs <= 0) {
      throw new RangeError("extensionMs must be positive.");
    }
    const active = this.#assertLease(leaseId, fencingToken);
    const renewed: ScheduledLease<TPayload> = {
      ...active.lease,
      expiresAt: now + extensionMs,
    };
    this.#active.set(leaseId, { lease: renewed });
    return renewed;
  }

  public sweepExpired(now = this.#clock()): readonly ScheduledLease<TPayload>[] {
    const expired: ScheduledLease<TPayload>[] = [];
    for (const active of [...this.#active.values()]) {
      if (active.lease.expiresAt > now) continue;
      this.#release(active.lease, "expired", active.lease.admittedCost);
      const state = this.#state(active.lease.item.tenant);
      state.expired += 1;
      this.#expired += 1;
      expired.push(active.lease);
      this.#emit({ type: "expired", lease: active.lease });
    }
    return expired;
  }

  public cancel(itemId: string): WorkItem<TPayload> | undefined {
    for (const [tenant, queue] of this.#queues) {
      const index = queue.findIndex((queued) => queued.item.id === itemId);
      if (index < 0) continue;
      const [removed] = queue.splice(index, 1);
      if (queue.length === 0) this.#queues.delete(tenant);
      if (removed === undefined) return undefined;
      this.#knownIds.delete(itemId);
      this.#emit({ type: "cancelled", item: removed.item });
      return removed.item;
    }
    return undefined;
  }

  public predict(workload: string, estimatedCost: ResourceVector): ResourceVector {
    validateCost(estimatedCost, this.#options.resources);
    return this.#costModel.predict(workload, estimatedCost).estimated;
  }

  public snapshot(): SchedulerSnapshot {
    const tenants = new Set([...this.#tenants.keys(), ...this.#queues.keys()]);
    const tenantSnapshots: TenantSnapshot[] = [...tenants]
      .sort()
      .map((tenant) => {
        const state = this.#state(tenant);
        return {
          tenant,
          queued: this.#queues.get(tenant)?.length ?? 0,
          active: state.active,
          virtualFinish: state.virtualFinish,
          completed: state.completed,
          expired: state.expired,
          service: state.service,
        };
      });

    const resources = Object.fromEntries(
      Object.entries(this.#capacity).map(([resource, capacity]) => {
        const used = this.#globalUsage[resource] ?? 0;
        return [resource, { used, capacity, utilization: used / capacity }];
      }),
    );

    return {
      queued: [...this.#queues.values()].reduce((total, queue) => total + queue.length, 0),
      active: this.#active.size,
      completed: this.#completed,
      expired: this.#expired,
      resources,
      tenants: tenantSnapshots,
      jainFairnessIndex: jainFairnessIndex(tenantSnapshots.map((tenant) => tenant.service)),
    };
  }

  public onEvent(listener: SchedulerEventListener<TPayload>): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #chooseCandidate(now: number): Candidate<TPayload> | undefined {
    let best: Candidate<TPayload> | undefined;
    for (const [tenant, queue] of this.#queues) {
      const candidate = this.#candidateForTenant(tenant, queue, now);
      if (
        candidate !== undefined
        && (best === undefined
          || candidate.score < best.score
          || (candidate.score === best.score && candidate.queued.sequence < best.queued.sequence))
      ) {
        best = candidate;
      }
    }
    return best;
  }

  #candidateForTenant(
    tenant: string,
    queue: readonly QueuedItem<TPayload>[],
    now: number,
  ): Candidate<TPayload> | undefined {
    const policy = this.#policyResolver.resolve(tenant);
    if (this.#state(tenant).active >= policy.maxConcurrency) return undefined;

    for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
      const queued = queue[queueIndex];
      if (queued === undefined) continue;
      const admittedCost = this.#costModel.predict(
        queued.item.workload,
        queued.item.estimatedCost,
      ).estimated;
      if (!this.#fits(tenant, admittedCost)) continue;

      const state = this.#state(tenant);
      const service = dominantShare(admittedCost, this.#options.resources) / policy.weight;
      const virtualStart = Math.max(state.virtualFinish, this.#virtualClock);
      const virtualFinish = virtualStart + service;
      const priorityBoost = ((queued.item.priority ?? 0) / 100) * 0.25;
      const age = Math.max(0, now - (queued.item.createdAt ?? now));
      const ageBoost = Math.log2(1 + age / this.#tuning.agingHalfLifeMs) * 0.1;
      const deadlineBoost = calculateDeadlineBoost(
        queued.item.deadline,
        now,
        this.#tuning.deadlineHorizonMs,
      );

      return {
        queued,
        queueIndex,
        admittedCost,
        score: virtualFinish - priorityBoost - ageBoost - deadlineBoost,
        virtualFinish,
      };
    }
    return undefined;
  }

  #fits(tenant: string, cost: ResourceVector): boolean {
    if (!fits(this.#globalUsage, cost, this.#capacity)) return false;

    for (const policy of this.#policyResolver.matchingPolicies(tenant)) {
      const consumption = this.#scope(policy.scope);
      if (policy.maxConcurrency !== undefined && consumption.active >= policy.maxConcurrency) {
        return false;
      }
      if (policy.resourceLimits !== undefined && !fits(consumption.resources, cost, policy.resourceLimits)) {
        return false;
      }
    }
    return true;
  }

  #admit(candidate: Candidate<TPayload>, now: number): ScheduledLease<TPayload> {
    const tenant = candidate.queued.item.tenant;
    const queue = this.#queues.get(tenant);
    if (queue === undefined) throw new Error("Invariant violation: candidate queue disappeared.");
    queue.splice(candidate.queueIndex, 1);
    if (queue.length === 0) this.#queues.delete(tenant);

    const token = ++this.#fencingToken;
    const lease: ScheduledLease<TPayload> = {
      leaseId: `qw-${token.toString(36)}`,
      fencingToken: token,
      item: candidate.queued.item,
      admittedCost: candidate.admittedCost,
      acquiredAt: now,
      expiresAt: now + this.#tuning.leaseTtlMs,
      schedulingScore: candidate.score,
    };

    addInto(this.#globalUsage, candidate.admittedCost);
    for (const policy of this.#policyResolver.matchingPolicies(tenant)) {
      const consumption = this.#scope(policy.scope);
      consumption.active += 1;
      addInto(consumption.resources, candidate.admittedCost);
    }

    const state = this.#state(tenant);
    state.active += 1;
    state.virtualFinish = candidate.virtualFinish;
    this.#virtualClock = this.#minimumVirtualFinish();
    this.#active.set(lease.leaseId, { lease });
    this.#emit({ type: "admitted", lease });
    return lease;
  }

  #release(lease: ScheduledLease<TPayload>, outcome: "settled" | "expired", cost: ResourceVector): void {
    this.#active.delete(lease.leaseId);
    this.#knownIds.delete(lease.item.id);
    subtractFrom(this.#globalUsage, lease.admittedCost);
    for (const policy of this.#policyResolver.matchingPolicies(lease.item.tenant)) {
      const consumption = this.#scope(policy.scope);
      consumption.active = Math.max(0, consumption.active - 1);
      subtractFrom(consumption.resources, lease.admittedCost);
    }
    const state = this.#state(lease.item.tenant);
    state.active = Math.max(0, state.active - 1);
    if (outcome === "expired") {
      state.service += dominantShare(cost, this.#options.resources);
    }
  }

  #assertLease(leaseId: string, fencingToken: number): ActiveLease<TPayload> {
    const active = this.#active.get(leaseId);
    if (active === undefined) throw new UnknownLeaseError(`Lease '${leaseId}' is not active.`);
    if (active.lease.fencingToken !== fencingToken) {
      throw new StaleFencingTokenError(
        `Lease '${leaseId}' requires fencing token ${active.lease.fencingToken}; received ${fencingToken}.`,
      );
    }
    return active;
  }

  #state(tenant: string): TenantState {
    let state = this.#tenants.get(tenant);
    if (state === undefined) {
      state = {
        virtualFinish: this.#virtualClock,
        active: 0,
        completed: 0,
        expired: 0,
        service: 0,
      };
      this.#tenants.set(tenant, state);
    }
    return state;
  }

  #scope(scope: string): ScopeConsumption {
    let consumption = this.#scopeConsumption.get(scope);
    if (consumption === undefined) {
      consumption = { active: 0, resources: zeroVector(this.#options.resources) };
      this.#scopeConsumption.set(scope, consumption);
    }
    return consumption;
  }

  #minimumVirtualFinish(): number {
    const eligible = [...this.#tenants.entries()]
      .filter(([tenant, state]) => state.active > 0 || (this.#queues.get(tenant)?.length ?? 0) > 0)
      .map(([, state]) => state.virtualFinish);
    return eligible.length === 0 ? this.#virtualClock : Math.min(...eligible);
  }

  #validateItem(item: WorkItem<TPayload>, now: number): void {
    if (!item.id.trim()) throw new InvalidWorkItemError("Work item id cannot be empty.");
    if (!item.tenant.trim()) throw new InvalidWorkItemError("Work item tenant cannot be empty.");
    if (!item.workload.trim()) throw new InvalidWorkItemError("Work item workload cannot be empty.");
    validateCost(item.estimatedCost, this.#options.resources);
    if (
      item.priority !== undefined
      && (!Number.isFinite(item.priority) || item.priority < -100 || item.priority > 100)
    ) {
      throw new InvalidWorkItemError("Work item priority must be between -100 and 100.");
    }
    if (item.createdAt !== undefined && (!Number.isFinite(item.createdAt) || item.createdAt > now + 60_000)) {
      throw new InvalidWorkItemError("Work item createdAt must be a valid timestamp and not far in the future.");
    }
    if (item.deadline !== undefined && !Number.isFinite(item.deadline)) {
      throw new InvalidWorkItemError("Work item deadline must be a valid timestamp.");
    }
  }

  #emit(event: SchedulerEvent<TPayload>): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        // Observability hooks cannot compromise admission-control correctness.
      }
    }
  }
}

function compareQueuedItems<TPayload>(left: QueuedItem<TPayload>, right: QueuedItem<TPayload>): number {
  const leftDeadline = left.item.deadline ?? Number.POSITIVE_INFINITY;
  const rightDeadline = right.item.deadline ?? Number.POSITIVE_INFINITY;
  if (leftDeadline !== rightDeadline) return leftDeadline - rightDeadline;

  const priority = (right.item.priority ?? 0) - (left.item.priority ?? 0);
  return priority !== 0 ? priority : left.sequence - right.sequence;
}

function calculateDeadlineBoost(deadline: number | undefined, now: number, horizon: number): number {
  if (deadline === undefined) return 0;
  const remaining = deadline - now;
  if (remaining <= 0) return 1 + Math.min(4, Math.abs(remaining) / horizon);
  if (remaining >= horizon) return 0;
  return ((horizon - remaining) / horizon) * 0.5;
}

function normalizeTuning(options: SchedulerOptions): NormalizedTuning {
  const tuning = { ...DEFAULT_TUNING, ...options.tuning };
  const positiveFields = [
    ["leaseTtlMs", tuning.leaseTtlMs],
    ["agingHalfLifeMs", tuning.agingHalfLifeMs],
    ["deadlineHorizonMs", tuning.deadlineHorizonMs],
  ] as const;
  for (const [name, value] of positiveFields) {
    if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be positive.`);
  }
  if (!Number.isFinite(tuning.costLearningRate) || tuning.costLearningRate <= 0 || tuning.costLearningRate > 1) {
    throw new RangeError("costLearningRate must be in the range (0, 1].");
  }
  const [minimum, maximum] = tuning.costMultiplierRange;
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || minimum <= 0 || maximum < minimum) {
    throw new RangeError("costMultiplierRange must contain positive ascending values.");
  }
  return tuning;
}
