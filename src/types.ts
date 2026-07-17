export type ResourceVector = Readonly<Record<string, number>>;

export interface ResourceDefinition {
  /** Maximum simultaneous consumption available to the scheduler. */
  readonly capacity: number;
  /** Relative importance when calculating a job's dominant resource share. */
  readonly weight?: number;
  /** Optional capacity multiplier for controlled overcommitment. Defaults to 1. */
  readonly overcommit?: number;
}

export type ResourceCatalog = Readonly<Record<string, ResourceDefinition>>;

export interface TenantPolicy {
  /**
   * Hierarchical tenant scope. `*` matches everyone; `acme` also matches
   * `acme/research` and descendants.
   */
  readonly scope: string;
  /** Relative service share for this scope. The most specific value wins. */
  readonly weight?: number;
  /** Maximum active leases for the scope and all of its descendants. */
  readonly maxConcurrency?: number;
  /** Optional simultaneous resource ceilings for the scope. */
  readonly resourceLimits?: ResourceVector;
}

export interface SchedulerTuning {
  /** Lease duration before abandoned work is automatically reclaimed. */
  readonly leaseTtlMs?: number;
  /** How quickly waiting work gains precedence. */
  readonly agingHalfLifeMs?: number;
  /** Time window in which deadlines increasingly influence ordering. */
  readonly deadlineHorizonMs?: number;
  /** EWMA learning factor for estimated-to-actual cost correction. */
  readonly costLearningRate?: number;
  /** Clamp for learned cost multipliers. */
  readonly costMultiplierRange?: readonly [minimum: number, maximum: number];
}

export interface SchedulerOptions {
  readonly resources: ResourceCatalog;
  readonly policies?: readonly TenantPolicy[];
  readonly tuning?: SchedulerTuning;
  /** Injectable clock for deterministic tests and simulations. */
  readonly clock?: () => number;
}

export interface WorkItem<TPayload = unknown> {
  readonly id: string;
  readonly tenant: string;
  readonly workload: string;
  readonly estimatedCost: ResourceVector;
  readonly payload?: TPayload;
  /** Higher numbers run sooner inside fairness bounds. Range: -100 to 100. */
  readonly priority?: number;
  readonly createdAt?: number;
  readonly deadline?: number;
  readonly idempotencyKey?: string;
}

export interface ScheduledLease<TPayload = unknown> {
  readonly leaseId: string;
  readonly fencingToken: number;
  readonly item: WorkItem<TPayload>;
  readonly admittedCost: ResourceVector;
  readonly acquiredAt: number;
  readonly expiresAt: number;
  readonly schedulingScore: number;
}

export interface Settlement {
  readonly actualCost?: ResourceVector;
  readonly completedAt?: number;
}

export interface TenantSnapshot {
  readonly tenant: string;
  readonly queued: number;
  readonly active: number;
  readonly virtualFinish: number;
  readonly completed: number;
  readonly expired: number;
  readonly service: number;
}

export interface SchedulerSnapshot {
  readonly queued: number;
  readonly active: number;
  readonly completed: number;
  readonly expired: number;
  readonly resources: Readonly<Record<string, {
    readonly used: number;
    readonly capacity: number;
    readonly utilization: number;
  }>>;
  readonly tenants: readonly TenantSnapshot[];
  readonly jainFairnessIndex: number;
}

export interface CostPrediction {
  readonly estimated: ResourceVector;
  readonly multipliers: ResourceVector;
}

export type SchedulerEvent<TPayload = unknown> =
  | { readonly type: "enqueued"; readonly item: WorkItem<TPayload> }
  | { readonly type: "admitted"; readonly lease: ScheduledLease<TPayload> }
  | { readonly type: "settled"; readonly lease: ScheduledLease<TPayload>; readonly actualCost: ResourceVector }
  | { readonly type: "expired"; readonly lease: ScheduledLease<TPayload> }
  | { readonly type: "cancelled"; readonly item: WorkItem<TPayload> };

export type SchedulerEventListener<TPayload = unknown> = (event: SchedulerEvent<TPayload>) => void;
