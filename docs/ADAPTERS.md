# Distributed adapter contract

QuotaWeave's in-memory core is the policy reference. A distributed adapter must preserve the following transaction boundaries.

## Required atomic operations

### Enqueue

- Reject an existing work-item ID.
- Reserve the idempotency key.
- Append the normalized work item to its tenant queue.

### Admit

- Verify global and hierarchical capacity.
- Remove the queued item.
- Increment resource and concurrency consumption.
- Advance tenant virtual time.
- Increment the shard fencing counter.
- Create the lease.

These changes must commit together. A Redis implementation can use a server-side function or Lua script. PostgreSQL can use a serializable transaction plus advisory locking per scheduler shard.

### Renew

- Compare the supplied fencing token.
- Extend only the matching active lease.

### Settle or expire

- Compare the fencing token.
- Delete the active lease exactly once.
- Release the admitted resource vector.
- Record actual resource consumption when trusted metering is available.

## Leadership

Use one active admission leader per shard. Followers may serve snapshots, but they must not issue leases unless they acquire a new leadership epoch. Include that epoch in externally persisted fencing tokens.

## Durable queue integration

Do not acknowledge the source queue message merely because QuotaWeave issued a lease. Acknowledge it after the worker has durably accepted the work, or use an outbox transaction that records both events. Expired leases should make work visible again according to the source queue's retry policy.

## Trust boundary

Tenant IDs, priorities, deadlines, and actual cost are policy-sensitive. Populate them from authenticated server-side context. Never trust a public client to select its own tenant weight or report its own resource usage.
