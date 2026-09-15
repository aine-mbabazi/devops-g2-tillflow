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
| [#28](https://github.com/aine-mbabazi/devops-g2-tillflow/pull/28) | STK callbacks + reconciliation; B2C payouts; Commission worker (this evidence covers #28 in detail) |

## Decisions

- [`docs/payment-contract.md`](../../docs/payment-contract.md) — POS → Payments contract, including the state-transition table and G2 acceptance scenarios.
- [`docs/commission-payout-contract.md`](../../docs/commission-payout-contract.md) — Commission → Payments B2C payout contract, including its own state-transition table and G2 acceptance scenarios.

## Reproduction commands

```bash
cd services/payments && npm test    # 22/22
cd services/commission && npm test  # 5/5
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

Scenarios 1, 8, 9 (full sandbox flow, cross-tenant rejection, POS-restart
durability) are **not yet provable** — they need a real POS integration and
a tenant-authorization layer, neither of which exists yet. See "Known gaps"
below.

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

Scenario 8 (cross-tenant rejection) has the same gap as above. Commission
"must never call Daraja directly" (the G2 hard blocker) is enforced as a
structural test, not just a design claim: `commission.test.js` — "commission
never imports a Daraja client" scans every file in `services/commission/src`
for an import from a `daraja` path and fails the suite if one exists.

## Manual runtime proof

```bash
cd services/payments && npm start   # DARAJA_MODE=fake, PAYMENT_STORE=memory by default

# create a payment
curl -s -X POST http://127.0.0.1:3001/payments \
  -H 'content-type: application/json' -H 'idempotency-key: demo-payment-1' \
  -d '{"tenant_id":"t1","sale_id":"s1","amount_minor":10000,"currency":"KES","customer_phone":"+254700000001"}'
# -> 202 { "payment_id": "payment_...", "status": "pending" }

# create a payout
curl -s -X POST http://127.0.0.1:3001/payouts \
  -H 'content-type: application/json' -H 'idempotency-key: demo-payout-1' \
  -d '{"tenant_id":"t1","attendant_id":"a1","commission_run_id":"run1","amount_minor":2500,"currency":"KES","recipient_phone":"+254700000002"}'
# -> 202 { "payout_id": "payout_...", "status": "pending" }
```

The fake Daraja client's outcome can only be flipped to `succeeded`/`failed`
from test code (`simulateOutcome`), not over HTTP, so seeing a `200`
callback response with a terminal status requires the automated suite above
rather than manual curl — see the payments service README for the full
explanation of that boundary.

## Known gaps (not covered by this PR)

- **No tenant/cross-tenant authorization.** `GET /payments/{id}` and
  `GET /payouts/{id}` don't check caller identity. Blocked on a design
  decision with the POS DRI and on `services/pos/` existing.
- **Not yet run against the real Daraja sandbox** — only the deterministic
  fake adapter, per the brief's CI rule. Real sandbox credentials require
  Platform to provision Secrets Manager values first.
- **No durable database in production.** `PostgresPaymentStore` and
  `PostgresPayoutStore` exist and are covered by the migrations in
  `services/payments/migrations/`, but no RDS instance is provisioned yet
  (Platform + delivery, tracked separately) — the deployed ECS task still
  runs `PAYMENT_STORE=memory`.
- **No trace evidence yet.** OTel/ADOT wiring for the payments service is
  in a separate, not-yet-merged PR (#24).
- **`services/commission`'s `paidSales` input is not sourced from a real
  POS** — `services/pos/` doesn't exist yet, so the daily-close flow is
  proven correct against synthetic sale data, not a live sale.
