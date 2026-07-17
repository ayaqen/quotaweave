import { ConfigurationError } from "./errors.js";
import type { ResourceCatalog, ResourceVector, TenantPolicy } from "./types.js";

export interface ResolvedPolicy {
  readonly weight: number;
  readonly maxConcurrency: number;
  readonly resourceLimits: ResourceVector;
  readonly matchedScopes: readonly string[];
}

export class PolicyResolver {
  readonly #policies: readonly TenantPolicy[];
  readonly #resources: ResourceCatalog;

  public constructor(policies: readonly TenantPolicy[], resources: ResourceCatalog) {
    this.#resources = resources;
    this.#policies = [...policies].sort((left, right) => specificity(left.scope) - specificity(right.scope));
    this.#validate();
  }

  public resolve(tenant: string): ResolvedPolicy {
    const matches = this.#policies.filter((policy) => scopeMatches(policy.scope, tenant));
    let weight = 1;
    let maxConcurrency = Number.POSITIVE_INFINITY;
    const resourceLimits: Record<string, number> = {};

    for (const policy of matches) {
      if (policy.weight !== undefined) weight = policy.weight;
      if (policy.maxConcurrency !== undefined) {
        maxConcurrency = Math.min(maxConcurrency, policy.maxConcurrency);
      }
      for (const [resource, limit] of Object.entries(policy.resourceLimits ?? {})) {
        resourceLimits[resource] = Math.min(resourceLimits[resource] ?? Number.POSITIVE_INFINITY, limit);
      }
    }

    return {
      weight,
      maxConcurrency,
      resourceLimits,
      matchedScopes: matches.map((policy) => policy.scope),
    };
  }

  public matchingPolicies(tenant: string): readonly TenantPolicy[] {
    return this.#policies.filter((policy) => scopeMatches(policy.scope, tenant));
  }

  #validate(): void {
    const scopes = new Set<string>();
    for (const policy of this.#policies) {
      if (!policy.scope.trim()) {
        throw new ConfigurationError("Policy scope cannot be empty.");
      }
      if (scopes.has(policy.scope)) {
        throw new ConfigurationError(`Duplicate policy scope '${policy.scope}'.`);
      }
      scopes.add(policy.scope);

      if (policy.weight !== undefined && (!Number.isFinite(policy.weight) || policy.weight <= 0)) {
        throw new ConfigurationError(`Policy '${policy.scope}' weight must be positive.`);
      }
      if (
        policy.maxConcurrency !== undefined
        && (!Number.isSafeInteger(policy.maxConcurrency) || policy.maxConcurrency < 1)
      ) {
        throw new ConfigurationError(`Policy '${policy.scope}' maxConcurrency must be a positive integer.`);
      }
      for (const [resource, limit] of Object.entries(policy.resourceLimits ?? {})) {
        if (!(resource in this.#resources)) {
          throw new ConfigurationError(`Policy '${policy.scope}' limits unknown resource '${resource}'.`);
        }
        if (!Number.isFinite(limit) || limit <= 0) {
          throw new ConfigurationError(`Policy '${policy.scope}' limit for '${resource}' must be positive.`);
        }
      }
    }
  }
}

export function scopeMatches(scope: string, tenant: string): boolean {
  return scope === "*" || tenant === scope || tenant.startsWith(`${scope}/`);
}

function specificity(scope: string): number {
  return scope === "*" ? -1 : scope.split("/").length;
}
