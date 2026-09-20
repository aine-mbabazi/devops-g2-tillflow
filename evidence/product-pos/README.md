# Product + POS — evidence

Normal DRI: @aine-mbabazi. This slice (`services/pos/`) was built by
@cheshari-pearl as a one-off, alongside the Payments + integrity work,
because @aine-mbabazi was unavailable ahead of the G2 deadline. It should
be reviewed and taken over by the Product + POS DRI going forward.

## What exists

- Tenant-scoped sale creation (`POST /sales`) — line items in integer minor
  units, server-computed total, idempotent on `(tenant_id, Idempotency-Key)`.
- Payment initiation (`POST /sales/{id}/pay`) — calls the Payments API with
  the sale's own ID as the idempotency key, so a restart or duplicate call
  can never dispatch a second STK push for the same sale.
- Reconciliation (`POST /sales/{id}/reconcile`) — polls Payments for the
  payment's status and marks the sale paid only after checking tenant, sale,
  amount, and currency all match POS's own record; a mismatch is preserved
  (never applied) and logged as `reconcile_mismatch` for investigation.
- Tenant setup (`PUT/GET /tenants/{id}/config`) — attendants, a commission
  rate, till configuration (each till names the attendants who work it), and
  tenant-scoped roles (role name → permitted actions), all scoped to the
  owning tenant. Tills and roles are optional; a config that omits them reads
  back with an empty list and an empty map, so older clients keep working.
- Paid-sales listing and claiming (`GET /sales?status=paid&commission_run_id=…`,
  `POST /sales/claim`) — the read/claim path Commission uses for its daily
  close. A sale claimed by one commission run is excluded from every other
  run's listing (but stays visible to a retry of the same run), so the same
  sale can never be paid commission on twice across separate daily closes.
- Every tenant-scoped route requires the same signed `X-Service-Auth` token
  as Payments (`services/_shared/service-auth.js`) — a tenant ID in a
  request body or query string is never authorization on its own.
- `PostgresSaleStore` / `PostgresTenantStore` — durable-storage equivalents
  of the in-memory stores, behind `POS_STORE=memory|postgres`, with
  migrations in `services/pos/migrations/`. No RDS instance exists yet
  (Platform + delivery), so this is code-ready but not yet actually durable
  anywhere it runs.

## Reproduction commands

```bash
cd services/pos && npm test   # 22/22
```

No external services required — the suite spins up a live Payments server
(backed by the deterministic fake Daraja adapter) and drives POS against it
over real HTTP, so the full sale -> STK -> callback -> reconcile -> paid
flow is proven end to end, not mocked.

## Acceptance scenarios → tests (`docs/payment-contract.md`)

| # | Scenario | Proven by |
|---|----------|-----------|
| 1 | A successful sandbox payment marks the correct tenant's sale paid once | "the full sale -> STK -> callback -> reconcile -> paid flow" |
| 2 | Sequential/concurrent retries with the same key produce one attempt | "an identical retry returns the same sale..." and "calling /pay twice dispatches only one STK push" |
| 3 | Reusing a key with changed input returns `409` | "an identical retry returns the same sale; changed input with the same key is rejected" |
| 6 | A timeout/crash after dispatch stays pending; reconciliation resolves it | "the full sale -> STK -> callback -> reconcile -> paid flow" (the "not yet resolved" reconcile-before-callback step) |
| 8 | Cross-tenant reads and writes are rejected without leaking data | "a tenant ID in the body alone is not authorization..." and the tenant-config cross-tenant test |
| 10 | Invalid or conflicting results can't mark a sale paid and are surfaced for investigation | "a reconciled payment that does not match the sale record is not applied, and is flagged" |

Scenario 9 (a POS restart eventually recording the sale paid) is only
provable once `POS_STORE=postgres` runs against a real RDS instance, which
doesn't exist yet — see "Known gaps."

## Known gaps

- **Roles are data, not enforcement.** `PUT /tenants/{id}/config` records a
  role → permissions map, but no route consults it yet. The roles exist so a
  future Web frontend has something to read; wiring permission checks into
  each POS route is the follow-up. The same caveat applies to *who* the owner
  is: today the owner is whoever holds a valid service-auth token for the
  tenant, not an individual user.
- **No inbound auth story for a future Web frontend.** The service-auth
  scheme here is symmetric-secret, service-to-service (POS ↔ Payments,
  Commission ↔ POS). It doesn't address how an end-user-facing Web app
  would authenticate individual owners/attendants — that's a different
  problem (user auth, not service auth) and is out of scope here.
- **No RDS instance provisioned.** `PostgresSaleStore`/`PostgresTenantStore`
  exist and have migrations, but nothing in `infra/` provisions the
  database itself (Platform + delivery) — every deployed environment still
  runs `POS_STORE=memory`.
- **Not deployed.** No `infra/` changes accompany this — no ECS service,
  ECR repo, or CI/CD stage exists for `services/pos/` yet.
