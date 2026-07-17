import { createHash } from "node:crypto";

export interface SchedulerShard {
  readonly id: string;
  readonly weight?: number;
}

/** Stable weighted rendezvous hashing for routing an entire tenant hierarchy. */
export class RendezvousShardRouter {
  readonly #shards: readonly Required<SchedulerShard>[];

  public constructor(shards: readonly SchedulerShard[]) {
    if (shards.length === 0) throw new RangeError("At least one scheduler shard is required.");
    const ids = new Set<string>();
    this.#shards = shards.map((shard) => {
      if (!shard.id.trim()) throw new RangeError("Scheduler shard id cannot be empty.");
      if (ids.has(shard.id)) throw new RangeError(`Duplicate scheduler shard '${shard.id}'.`);
      ids.add(shard.id);
      const weight = shard.weight ?? 1;
      if (!Number.isFinite(weight) || weight <= 0) {
        throw new RangeError(`Scheduler shard '${shard.id}' weight must be positive.`);
      }
      return { id: shard.id, weight };
    });
  }

  public route(tenant: string): string {
    if (!tenant.trim()) throw new RangeError("Tenant cannot be empty.");
    let selected = this.#shards[0];
    let selectedScore = Number.POSITIVE_INFINITY;

    for (const shard of this.#shards) {
      const score = weightedScore(tenant, shard);
      if (score < selectedScore || (score === selectedScore && shard.id < (selected?.id ?? ""))) {
        selected = shard;
        selectedScore = score;
      }
    }
    if (selected === undefined) throw new Error("Invariant violation: no shard selected.");
    return selected.id;
  }

  public distribution(tenants: readonly string[]): Readonly<Record<string, number>> {
    const counts = Object.fromEntries(this.#shards.map((shard) => [shard.id, 0])) as Record<string, number>;
    for (const tenant of tenants) {
      const shard = this.route(tenant);
      counts[shard] = (counts[shard] ?? 0) + 1;
    }
    return counts;
  }
}

function weightedScore(tenant: string, shard: Required<SchedulerShard>): number {
  const digest = createHash("sha256").update(tenant).update("\0").update(shard.id).digest();
  const integer = digest.readBigUInt64BE(0);
  const uniform = (Number(integer >> 11n) + 1) / 9_007_199_254_740_993;
  return -Math.log(uniform) / shard.weight;
}
