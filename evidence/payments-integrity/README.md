# Payments + integrity — evidence

DRI: @cheshari-pearl. Covers Daraja STK/B2C, callbacks, payment/payout state,
idempotency, reconciliation and replay, per [`docs/ownership.md`](../../docs/ownership.md).

## PRs

| PR | What it added |
|----|----------------|
| [#5](https://github.com/aine-mbabazi/devops-g2-tillflow/pull/5) | Payments service scaffold |
| [#9](https://github.com/aine-mbabazi/devops-g2-tillflow/pull/9) | Idempotent payments API (`POST /payments`, `GET /payments/{id}`) |
| [#13](https://github.com/aine-mbabazi/devops-g2-tillflow/pull/13) | PostgreSQL-backed payment store |
| [#16](https://github.com/aine-mbabazi/devops-g2-tillflow/pull/16) | Daraja sandbox STK Push client |
| [#28](https://github.com/aine-mbabazi/devops-g2-tillflow/pull/28) | STK callbacks + reconciliation; B2C payouts; Commission worker |
| (this branch) | Service-to-service auth (`services/_shared/service-auth.js`) enforced on all tenant-scoped Payments and POS routes; POS service (sale creation, tenant/attendant config, pay, reconcile) — POS is normally Product + POS's area, built here as a one-off because @aine-mbabazi was unavailable ahead of the G2 deadline; Commission wired to read real confirmed-paid sales and tenant config from POS instead of taking synthetic data as parameters |
| (this branch, reconciliation consumer) | Wires the `devops-g2-reconciliation` queue + DLQ (provisioned in PR #48, left unconsumed — see "Known gaps" there) with a producer and consumer in `services/payments`: `provider_dispatch_unconfirmed` now enqueues `{type, id}` for the payment or payout it just failed to confirm, and a long-polling consumer (`src/reconciliation-queue.js`) re-queries Daraja and transitions the record, following the same reconciliation order as callbacks (`docs/runbook.md#reconciliation-order`) |

## Decisions

- [`docs/payment-contract.md`](../../docs/payment-contract.md) — POS → Payments contract, including the state-transition table and G2 acceptance scenarios.
- [`docs/commission-payout-contract.md`](../../docs/commission-payout-contract.md) — Commission → Payments B2C payout contract, including its own state-transition table and G2 acceptance scenarios.

## Reproduction commands

```bash
cd services/payments && npm test    # 29/29
cd services/commission && npm test  # 9/9
cd services/pos && npm test         # 22/22
```

No external services, credentials, or network access required — both suites
run entirely against the deterministic fake Daraja adapter, per the brief's
CI rule ("CI and k6 must use a deterministic fake adapter — never real money
or customer data").

## Acceptance scenarios → tests

### `docs/payment-contract.md` (STK)

| # | Scenario | Proven by |
|---|----------|-----------|
| 2 | Sequential/concurrent retries with the same key → one attempt | `payments.test.js`: "returns the same payment for an identical retry without a second dispatch" |
| 3 | Reusing a key with changed input → `409` | `payments.test.js`: "rejects changed idempotency input, a duplicate sale, and invalid requests" |
| 4 | A different key can't start another payment for a pending/paid sale | same test, `sale_payment_exists` assertion |
| 5 | Duplicate/delayed callbacks can't apply success twice | `payments.test.js`: "replaying a callback after a terminal result is a no-op" |
| 6 | Timeout/crash after dispatch stays pending; reconciliation resolves it | `payments.test.js`: "callback verification failure leaves the payment pending for later reconciliation" |
| 10 | Invalid/conflicting callbacks can't mark paid and are surfaced for investigation | `payments.test.js`: "a malformed callback body is rejected before any lookup" and "a callback reporting an outcome that conflicts with the stored terminal state is preserved and flagged" (asserts the `callback_conflict` log event) |
| 1 | A successful sandbox payment marks the correct tenant's sale paid once | `services/pos/test/pos.test.js`: "the full sale -> STK -> callback -> reconcile -> paid flow" — a true end-to-end integration test through POS, a live Payments server, and the fake Daraja adapter |
| 8 | Cross-tenant reads/writes are rejected without leaking payment data | `payments.test.js`: "a tenant ID in the request body alone is not authorization" and "a payment cannot be read by a tenant other than its own, without revealing whether it exists" |

Scenario 9 (a POS restart eventually recording the sale paid) is **not yet
provable** — `InMemorySaleStore` loses state on restart, the same durability
gap as Payments' in-memory store. See "Known gaps" below.

### `docs/commission-payout-contract.md` (B2C)

| # | Scenario | Proven by |
|---|----------|-----------|
| 1 | A successful payout marks exactly one ledger item paid | `commission.test.js`: "daily close calculates from confirmed paid sales and requests exactly one B2C payout per attendant" |
| 2 | Sequential/concurrent retries with the same key → one attempt | `payments.test.js`: "returns the same payout for an identical retry without a second B2C dispatch" |
| 3 | Reusing a key with changed input → `409` | `payments.test.js`: "rejects changed idempotency input and a second payout for the same ledger item" |
| 4 | Re-running a daily close can't create a second payout for the same ledger item | `commission.test.js`: "re-running the same daily close cannot double-pay" — runs `runDailyClose` twice against a live fake-Daraja-backed Payments server and asserts the B2C dispatch count stays at 1 |
| 5 | Duplicate/delayed callback can't mark a payout successful twice | `payments.test.js`: "a verified Daraja callback transitions a pending payout to succeeded... replay ... are handled the same as payments" (replay assertion) |
| 6 | Timeout/crash after dispatch stays pending; reconciliation resolves it | `payments.test.js`: "payout callback verification failure leaves it pending; unknown/malformed callbacks are rejected" |
| 10 | Invalid/conflicting callbacks can't mark a payout successful, surfaced for investigation | same test (malformed/unknown), plus the conflict assertion in the "verified Daraja callback..." test |
| 8 | Cross-tenant payout reads and writes are rejected without leaking data | `payments.test.js`: "payouts enforce the same service-auth boundary as payments" |

Commission "must never call Daraja directly" (the G2 hard blocker) is enforced as a
structural test, not just a design claim: `commission.test.js` — "commission
never imports a Daraja client" scans every file in `services/commission/src`
for an import from a `daraja` path and fails the suite if one exists.

## Manual runtime proof

Every tenant-scoped route now requires a signed `X-Service-Auth` header (see
`services/_shared/service-auth.js`), so a plain curl call needs a one-line
Node snippet to sign it:

```bash
cd services/payments && SERVICE_AUTH_SECRET=local-dev-secret npm start

# sign a token for tenant t1 (valid 5 minutes)
TOKEN=$(node -e "import('./src/../../_shared/service-auth.js').then(({signServiceAuth}) => console.log(signServiceAuth('t1','local-dev-secret')))")

# create a payment
curl -s -X POST http://127.0.0.1:3001/payments \
  -H 'content-type: application/json' -H 'idempotency-key: demo-payment-1' -H "x-service-auth: $TOKEN" \
  -d '{"tenant_id":"t1","sale_id":"s1","amount_minor":10000,"currency":"KES","customer_phone":"+254700000001"}'
# -> 202 { "payment_id": "payment_...", "status": "pending" }

# create a payout
curl -s -X POST http://127.0.0.1:3001/payouts \
  -H 'content-type: application/json' -H 'idempotency-key: demo-payout-1' -H "x-service-auth: $TOKEN" \
  -d '{"tenant_id":"t1","attendant_id":"a1","commission_run_id":"run1","amount_minor":2500,"currency":"KES","recipient_phone":"+254700000002"}'
# -> 202 { "payout_id": "payout_...", "status": "pending" }

# same token, wrong tenant in the body -> 403
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:3001/payments \
  -H 'content-type: application/json' -H 'idempotency-key: demo-payment-2' -H "x-service-auth: $TOKEN" \
  -d '{"tenant_id":"t2","sale_id":"s2","amount_minor":10000,"currency":"KES","customer_phone":"+254700000001"}'
# -> 403
```

The fake Daraja client's outcome can only be flipped to `succeeded`/`failed`
from test code (`simulateOutcome`), not over HTTP, so seeing a `200`
callback response with a terminal status requires the automated suite above
rather than manual curl — see the payments service README for the full
explanation of that boundary.

## Fixed after independent review

An external review of this branch found several real issues, addressed as follows:

- **Commission was double-counting historical paid sales.** `runDailyClose`
  fetched *all* confirmed-paid sales with no per-run exclusion — two
  separate daily closes would both calculate commission on the same
  underlying sales, and since each run has its own `commissionRunId`,
  Payments' idempotency didn't catch it (different runs = different
  idempotency keys = a second, legitimate-looking payout). Fixed with sale
  "claiming": POS now tracks a `commission_run_id` per sale, excludes any
  sale already claimed by a *different* run from `GET /sales?status=paid`,
  and Commission claims the sales it used only after Payments durably
  accepts the payout request. Regression test:
  `commission.test.js` — "a sale already paid commission on by a previous
  day's close is excluded from the next day's close."
- **Startup logs leaked secrets.** `payments/src/server.js` spread the
  entire config object (including `SERVICE_AUTH_SECRET`, `DATABASE_URL`,
  and Daraja sandbox credentials) into a log line on every boot. Fixed to
  log only non-secret fields.
- **The Payments Docker build was broken by this branch's own change.**
  `app.js` imports `services/_shared/service-auth.js`, but the Dockerfile's
  build context was `services/payments/` alone — the shared module was
  never in the image. Fixed by building from the repo root
  (`docker build -f services/payments/Dockerfile .`) while preserving the
  monorepo directory layout inside the image, so the existing relative
  import needs no code change. Verified by replicating the exact `COPY`
  layout in a temp directory and running the entry point's import graph
  (Docker itself isn't available in this environment). `pr.yml` and
  `release.yml` updated to match.
- **Payout completion was never written back to the commission ledger.**
  `runDailyClose` recorded whatever status Payments returned synchronously
  (almost always `pending`, since B2C is async) and nothing ever updated
  it. Added `reconcilePendingLedgerEntries`, wired into `run.js` before
  each close. Test: "reconcilePendingLedgerEntries updates the ledger once
  Payments resolves a payout."
- **PR CI only ran Payments' tests.** `pr.yml` had no job for `services/pos`
  or `services/commission`. Added `pos-tests` and `commission-tests` jobs.

## Reconciliation queue behavior

An enqueued message is resolved in one of four ways, mirroring the callback
handlers rather than inventing new semantics:

| Record state when picked up | Action |
|---|---|
| Already terminal (or gone) | No-op, message deleted — at-least-once delivery means this may be a duplicate of one already handled |
| Pending, has a provider request ID, Daraja returns terminal | Transitioned, message deleted, `reconciled` logged |
| Pending, has a provider request ID, Daraja still says pending | Left on the queue for redelivery — never inferred as an outcome |
| Pending, **no** provider request ID (the dispatch call itself never got one back) | Left on the queue; after five receives it lands in the DLQ for a human, per `docs/runbook.md#reconciliation-dlq` — there is nothing to query yet, and inventing one would guess at a state nobody can confirm |

Proof: `cd services/payments && npm test` includes `test/reconciliation-queue.test.js`
(11 cases against a fake SQS client, mirroring how `FakeDarajaClient` avoids
real network calls) and a `payments.test.js` case asserting `app.js` actually
calls `enqueue` on both dispatch-failure sites.

## Known gaps (still not covered)

- **Not yet run against the real Daraja sandbox** — only the deterministic
  fake adapter, per the brief's CI rule. Real sandbox credentials require
  Platform to provision Secrets Manager values first.
- **No RDS instance provisioned.** `PostgresPaymentStore`/`PostgresPayoutStore`
  (Payments) and the newly-added `PostgresSaleStore`/`PostgresTenantStore`
  (POS) and `PostgresCommissionLedger` (Commission) all exist, are wired
  behind a `*_STORE=memory|postgres` config flag, and have migrations —
  but no RDS instance exists yet (Platform + delivery, tracked separately),
  so every deployed environment still runs in memory. This is genuinely
  blocked on infra, not a code gap.
- **No trace evidence yet.** OTel/ADOT wiring for the payments service is
  in a separate, not-yet-merged PR (#24).
- **POS and Commission are not yet deployed** — no ECS service, ECR repo,
  or CI/CD release stage exists for either yet (Platform + delivery scope).
- **`SERVICE_AUTH_SECRET` (and `DATABASE_URL`, for whichever service turns
  on `*_STORE=postgres` first) are not yet wired into deployed
  infrastructure** — needs a Secrets Manager entry and task-definition env
  vars before any of this runs in ECS.
