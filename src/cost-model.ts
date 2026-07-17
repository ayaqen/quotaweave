import type { CostPrediction, ResourceCatalog, ResourceVector } from "./types.js";

interface CostModelOptions {
  readonly learningRate: number;
  readonly multiplierRange: readonly [number, number];
}

export class AdaptiveCostModel {
  readonly #multipliers = new Map<string, Record<string, number>>();
  readonly #resources: ResourceCatalog;
  readonly #options: CostModelOptions;

  public constructor(resources: ResourceCatalog, options: CostModelOptions) {
    this.#resources = resources;
    this.#options = options;
  }

  public predict(workload: string, estimated: ResourceVector): CostPrediction {
    const learned = this.#multipliers.get(workload) ?? {};
    const adjusted: Record<string, number> = {};
    const multipliers: Record<string, number> = {};

    for (const [resource, amount] of Object.entries(estimated)) {
      const multiplier = learned[resource] ?? 1;
      adjusted[resource] = amount * multiplier;
      multipliers[resource] = multiplier;
    }

    return { estimated: adjusted, multipliers };
  }

  public observe(workload: string, estimated: ResourceVector, actual: ResourceVector): void {
    const learned = { ...(this.#multipliers.get(workload) ?? {}) };
    const [minimum, maximum] = this.#options.multiplierRange;

    for (const resource of Object.keys(this.#resources)) {
      const expected = estimated[resource] ?? 0;
      const observed = actual[resource] ?? 0;
      if (expected <= 0) continue;

      const ratio = clamp(observed / expected, minimum, maximum);
      const current = learned[resource] ?? 1;
      learned[resource] = clamp(
        current + this.#options.learningRate * (ratio - current),
        minimum,
        maximum,
      );
    }

    this.#multipliers.set(workload, learned);
  }

  public reset(workload?: string): void {
    if (workload === undefined) this.#multipliers.clear();
    else this.#multipliers.delete(workload);
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
