import { ConfigurationError, InvalidWorkItemError } from "./errors.js";
import type { ResourceCatalog, ResourceVector } from "./types.js";

export function zeroVector(resources: ResourceCatalog): Record<string, number> {
  return Object.fromEntries(Object.keys(resources).map((resource) => [resource, 0]));
}

export function validateCatalog(resources: ResourceCatalog): void {
  const entries = Object.entries(resources);
  if (entries.length === 0) {
    throw new ConfigurationError("At least one resource must be configured.");
  }

  for (const [name, definition] of entries) {
    if (!name.trim()) {
      throw new ConfigurationError("Resource names cannot be empty.");
    }
    assertPositive(definition.capacity, `Resource '${name}' capacity`);
    if (definition.weight !== undefined) {
      assertPositive(definition.weight, `Resource '${name}' weight`);
    }
    if (definition.overcommit !== undefined) {
      assertPositive(definition.overcommit, `Resource '${name}' overcommit`);
    }
  }
}

export function validateCost(cost: ResourceVector, resources: ResourceCatalog, label = "Cost"): void {
  const entries = Object.entries(cost);
  if (entries.length === 0) {
    throw new InvalidWorkItemError(`${label} must contain at least one resource.`);
  }

  for (const [resource, amount] of entries) {
    if (!(resource in resources)) {
      throw new InvalidWorkItemError(`${label} uses unknown resource '${resource}'.`);
    }
    if (!Number.isFinite(amount) || amount < 0) {
      throw new InvalidWorkItemError(`${label} resource '${resource}' must be a finite non-negative number.`);
    }
  }

  if (entries.every(([, amount]) => amount === 0)) {
    throw new InvalidWorkItemError(`${label} cannot be entirely zero.`);
  }
}

export function addInto(target: Record<string, number>, vector: ResourceVector): void {
  for (const [resource, amount] of Object.entries(vector)) {
    target[resource] = (target[resource] ?? 0) + amount;
  }
}

export function subtractFrom(target: Record<string, number>, vector: ResourceVector): void {
  for (const [resource, amount] of Object.entries(vector)) {
    const next = (target[resource] ?? 0) - amount;
    target[resource] = Math.abs(next) < 1e-12 ? 0 : Math.max(0, next);
  }
}

export function fits(
  used: ResourceVector,
  requested: ResourceVector,
  limits: ResourceVector,
): boolean {
  for (const [resource, amount] of Object.entries(requested)) {
    const limit = limits[resource];
    if (limit !== undefined && (used[resource] ?? 0) + amount > limit + Number.EPSILON) {
      return false;
    }
  }
  return true;
}

export function dominantShare(cost: ResourceVector, resources: ResourceCatalog): number {
  let dominant = 0;
  for (const [resource, amount] of Object.entries(cost)) {
    const definition = resources[resource];
    if (definition === undefined) continue;
    const weightedCapacity = definition.capacity * (definition.weight ?? 1);
    dominant = Math.max(dominant, amount / weightedCapacity);
  }
  return dominant;
}

export function configuredCapacity(resources: ResourceCatalog): Record<string, number> {
  return Object.fromEntries(
    Object.entries(resources).map(([name, definition]) => [
      name,
      definition.capacity * (definition.overcommit ?? 1),
    ]),
  );
}

function assertPositive(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new ConfigurationError(`${label} must be a finite positive number.`);
  }
}
