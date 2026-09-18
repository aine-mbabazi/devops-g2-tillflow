# ADR 0004 — Cache-aside on tenant config, and a reconciliation work queue

- **Status:** Accepted
- **Date:** 2026-09-18
- **DRI:** @aine-mbabazi (Platform + delivery — Terraform, data services, caching)
- **Cross-review:** @cheshari-pearl (Payments + integrity), @mercykilonzo (Reliability + operations)

## Context

The platform baseline in the brief requires "Redis/Valkey (ElastiCache)
cache-aside" and "SQS + DLQ". Neither existed. Adding them because a document
says so produces infrastructure nobody can defend, so each needs a real problem.

Two real problems existed:

1. **Read amplification on tenant config.** `GET /tenants/:id/config` is read on
   essentially every screen an attendant touches and written only when an owner
   reconfigures their till. Every one of those reads hits the same
   `db.t4g.micro` instance that POS, Payments and Commission all share — which
   the runbook already names as the most likely next cause of a latency breach.

2. **Uncertain payments resolved by a human.** When a Daraja dispatch is
   unconfirmed, the payment is durably recorded as `pending` and something has
   to come back later and resolve it against the provider. That "something" was
   a person reading `provider_dispatch_unconfirmed` in CloudWatch Logs.

## Decision

### Cache-aside on tenant config only

A single-node Valkey replication group on ElastiCache, with cache-aside over
`GET /tenants/:id/config` and a 60-second TTL. Implemented as a decorator
(`CachingTenantStore`) rather than inside the Postgres store, so the persistence
class stays cache-free and each can be reasoned about alone.

**Nothing about money is cached.** Sale and payment state is read from Postgres
every time. A stale payment status is how a double charge happens, and the read
volume on those paths does not justify the risk anyway.

Invalidation is delete-on-write, not write-through. `configure` normalises its
input — trimming, de-duplicating role permissions — so the stored config is not
always byte-identical to what was submitted. Deleting and letting the next read
repopulate cannot serve a value the database never held.

Every cache operation fails open. If Valkey is unreachable, reads fall through
to Postgres and the request succeeds, slower. A cache outage that took POS down
with it would be a strictly worse system than no cache at all.

### SQS + DLQ for reconciliation

One standard queue with a dead-letter queue after five receives. A message is
enqueued per payment whose dispatch was unconfirmed; a consumer re-queries
Daraja and transitions the payment.

## Alternatives considered

**Caching sale and payment reads too.** Rejected. It is where the read volume
would eventually be, and it is exactly where staleness costs money rather than
milliseconds.

**Write-through instead of delete-on-write.** Rejected: see normalisation above.

**Redis OSS instead of Valkey.** Same protocol and the same client libraries,
so this is reversible either way. Valkey chosen for cost and to avoid the
licence question. The application talks RESP and does not know the difference.

**Multi-AZ cache with automatic failover.** Rejected, consistent with the
single-AZ RDS trade in ADR 0002. A cache is the component where that trade costs
least: losing it costs latency, not data, and the application already keeps
serving without it.

**An auth token on the cache.** Rejected. Access is already constrained to the
ECS tasks' security group inside private subnets; an auth token would need to
live in Secrets Manager and be rotated, for a cache holding no secret data.
Transit and at-rest encryption are both on regardless.

**A cron sweep over pending payments instead of a queue.** Rejected. A sweep
re-reads every pending payment on every pass, so its cost grows with the backlog
precisely when the backlog is growing. A per-payment message reconciles each
payment once, at a predictable time.

**EventBridge instead of SQS.** Rejected. This needs a retry budget, a
visibility timeout and a dead-letter queue — a work queue, not an event bus.
EventBridge already has a job here (the daily commission schedule) and it is a
different job.

## Consequences

**Good.**

- Tenant config reads stop reaching Postgres on every request, which buys
  headroom on the shared instance ahead of the POS latency SLO.
- Uncertain payments resolve without a human, and the ones that cannot resolve
  land in a DLQ that alarms at a threshold of zero.
- The DLQ gives the game-day "platform failure" drill something concrete to
  observe, which it did not have before.

**Bad, and accepted.**

- **A second stateful dependency.** Mitigated by failing open everywhere and by
  the eviction alarm, but it is one more thing that can be down.
- **Up to 60 seconds of staleness** on a tenant reconfiguration, in the failure
  case where invalidation itself fails. Logged distinctly as
  `cache_invalidation_failed` with `staleUntilTtl: true` rather than hidden
  among the harmless cache errors.
- **Cost.** `cache.t4g.micro` is roughly $12/month on-demand in `us-east-2`, on
  top of the existing spend. For a demo system this is real money for a
  measurable but not yet load-bearing benefit; the honest justification is that
  the brief requires the capability and this is the cheapest defensible shape
  for it.
- **At-least-once delivery.** SQS may deliver a reconciliation message more than
  once. The reconciler must be idempotent — it already is, because transitioning
  an already-terminal payment is a no-op — but that property is now load-bearing
  rather than incidental, and a regression test guards it.

## Proof

- `services/pos/test/cache.test.js` — hit/miss/invalidation, no negative
  caching, and the fail-open path under a cache outage.
- `docs/capacity-model.md` — the read-path latency before and after, measured
  with the same k6 profile against the same services.
