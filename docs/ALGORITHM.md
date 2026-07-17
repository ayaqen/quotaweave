# Scheduling algorithm

QuotaWeave combines weighted fair queuing with dominant-resource accounting.

For each candidate job, it calculates the largest share consumed across all configured resources:

```text
dominant_share(job) = max(cost(resource) / weighted_capacity(resource))
```

The tenant's virtual finish time advances by that share divided by the tenant weight:

```text
virtual_finish = max(tenant_finish, virtual_clock) + dominant_share / tenant_weight
```

The lowest virtual finish wins after bounded priority, deadline, and age adjustments. Weight therefore changes long-run service share, while priority changes short-run ordering. Age grows logarithmically so an old job gains precedence without allowing one stale item to permanently dominate the system.

## Admission sequence

1. Validate identifiers, timestamps, priority, and resource names.
2. Apply the workload's learned estimated-to-actual cost multipliers.
3. Reject candidates that do not fit global simultaneous capacity.
4. Evaluate every matching hierarchical policy scope.
5. Select one eligible candidate from each tenant.
6. Compare candidates by adjusted virtual finish time.
7. Allocate resources and issue an expiring lease with a monotonic fencing token.
8. On settlement, release the admitted allocation and update the workload cost model.

## Adaptive cost model

QuotaWeave maintains an exponentially weighted moving average of `actual / estimated` for each workload and resource. Multipliers are clamped to a configured interval so a single corrupted observation cannot make a workload impossible to schedule or effectively free.

The default learning rate is `0.2`, and the multiplier range is `[0.25, 4]`. Production adapters should treat actual cost as trusted metering data, not caller-provided input.

## Complexity

Let `T` be the number of active tenants, `Q` the average number of jobs inspected within a tenant, `R` the number of resources, and `P` the number of matching policies. One admission decision is approximately `O(T × Q × (R + P))` in the reference implementation.

At larger scale, route tenants across scheduler shards, keep per-tenant candidate heaps, and limit head-of-line inspection. The deterministic reference implementation prioritizes auditability and adapter correctness over a specialized indexed data structure.
