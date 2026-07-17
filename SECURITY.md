# Security policy

## Reporting a vulnerability

Please use GitHub's private vulnerability-reporting feature for this repository. Do not open a public issue containing an exploit, secret, or tenant data.

## Integration requirements

- Derive tenant identity from authenticated server-side context.
- Treat priority, deadlines, and policy scope as privileged fields.
- Meter actual resource use from infrastructure you control.
- Validate a lease's fencing token at every external side-effect boundary.
- Keep scheduler policy changes auditable and versioned.
- Place limits on payload size before persisting queued work.
- Never store credentials or raw customer data in scheduler events.

QuotaWeave is an admission-control primitive, not an authentication, authorization, durable-queue, or distributed-consensus system.
