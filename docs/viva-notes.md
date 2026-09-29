# Viva notes — honest, code-cited answers

Prep for three questions a reviewer is likely to ask directly. Each answer
names the exact file/line it rests on rather than describing behavior from
memory, and states the gap plainly where there is one — same rule the rest
of this repo's evidence holds to.

---

## 1. Is `/payments/callbacks/daraja` an amplification vector?

**Yes, and the mechanism is exactly what it looks like.**

The route (`services/payments/src/app.js:133-136`) is deliberately
unauthenticated — it's a public webhook Daraja itself calls, so it can't
require the internal `X-Service-Auth` header every other route checks. That
part is correct and unavoidable. The problem is what happens *after* the
request arrives, with nothing else standing in front of it:

```js
// app.js:133-138
if (path === '/payments/callbacks/daraja' && req.method === 'POST') {
  let checkoutRequestId;
  try { checkoutRequestId = (await readJsonBody(req))?.Body?.stkCallback?.CheckoutRequestID; } catch { checkoutRequestId = null; }
  if (!validString(checkoutRequestId)) { statusCode = 400; sendJson(res, statusCode, { error: 'invalid_callback' }); return; }
  const payment = await paymentStore.findByProviderRequestId(checkoutRequestId);
  if (!payment) { statusCode = 404; sendJson(res, statusCode, { error: 'not_found' }); return; }
```

`findByProviderRequestId` runs — a real database round trip — before any
authentication, any rate limit, or any per-caller identity exists to check
against. There's no rate limiting anywhere in this codebase or in
`infra/main/apigateway.tf`; I checked. `docs/production-readiness.md` §4
already names "No WAF on API Gateway" as a known gap — this is the concrete
consequence of that gap on this specific route.

Two distinct costs stack on every POST, valid or not:

1. **A DB round trip against a shared, single `db.t4g.micro`.** `provider_request_id`
   has a `UNIQUE` constraint (`migrations/001_create_payment_attempts.sql:13`),
   so the lookup itself is indexed and cheap per-query — this isn't a
   full-table-scan amplifier. The amplification is *volume*: nothing stops
   an attacker from sending thousands of these per second, each opening a
   pooled connection on the same instance POS and Commission also depend on.
2. **If the ID happens to match a real, currently-pending payment**, line
   140 fires an outbound call to Daraja's own query API
   (`darajaClient.queryPayment`). A legitimate payer replaying their own
   callback at volume — which they can, since nothing ties a callback to a
   single delivery — burns TillFlow's own Daraja API quota, on TillFlow's
   dime, with no rate limit gating it.

**What actually stops damage today, and what doesn't:** idempotency at the
DB layer means a flood of *valid* replays can't double-credit a sale — the
worst a replay does is a no-op `callback_conflict` log line or a repeated
200. That's a correctness mitigation, not a rate-limiting one. Nothing
stops the *volume* itself from degrading the shared RDS instance or eating
the Daraja quota other legitimate callbacks need. The 16 KB body cap
(`app.js:6`) bounds payload size, not request count.

**If asked "what's the fix":** API Gateway usage plans / throttling in
front of this specific route, or a WAF rate-based rule — neither exists yet.
Both are infra-layer fixes; nothing in the application code needs to
change.

---

## 2. Is there amount verification on settlement? Where does the gap actually get caught?

**No — Payments never checks the settled amount against the requested
amount, anywhere. POS's reconcile step is the only place amount actually
gets compared, and even that isn't a check against Daraja's real
settlement — it's TillFlow cross-checking its own two records.**

Trace it end to end:

- **The raw callback body is thrown away except for one field.**
  `app.js:135` extracts only `Body.stkCallback.CheckoutRequestID`. A real
  Daraja STK callback's `CallbackMetadata.Item` array carries `Amount`,
  `MpesaReceiptNumber`, `TransactionDate`, `PhoneNumber` — none of it is
  read.
- **The reconciliation query doesn't carry amount either, sandbox or
  fake.** `FakeDarajaClient#queryPayment` (`services/payments/src/daraja/fake-client.js:29-32`)
  returns `{ providerRequestId, status }` only. The real sandbox client is
  the same shape:
  ```js
  // sandbox-client.js:135-136
  if (body.ResultCode === '0' || body.ResultCode === 0) return { providerRequestId, status: 'succeeded' };
  return { providerRequestId, status: 'failed' };
  ```
  `ResultCode` in, `succeeded`/`failed` out. No amount field is extracted
  or compared even though Daraja's transaction-status response carries one
  in production.
- **`app.js:152`'s `transition()` call moves the payment to `succeeded`
  purely on that status** — nothing about the amount TillFlow originally
  requested (`payment.amountMinor`, stored at creation) is re-checked
  against what Daraja says it actually moved.

**The one place amount is checked at all** is POS's `/sales/:id/reconcile`
(`services/pos/src/app.js:228-249`):

```js
// app.js:239-247
// Never trust a bare "succeeded" — the sale is only marked paid once
// Payments' own record of tenant, sale, amount, and currency for this
// payment matches POS's own authoritative sale record exactly.
const matches = payment.tenant_id === sale.tenantId && payment.sale_id === sale.id
  && payment.amount_minor === sale.amountMinor && payment.currency === sale.currency;
if (!matches) {
  log({ event: 'reconcile_mismatch', saleId: sale.id, paymentId: sale.paymentId, payment });
  statusCode = 200; sendJson(res, statusCode, toSaleResponse(sale)); return;
}
```

**The honest limitation, if pressed on it:** this compares POS's stored
`sale.amountMinor` against Payments' stored `payment.amount_minor` — two
TillFlow-internal records of what was *intended*, both written before the
STK push was ever sent. It is a self-consistency check between two of
TillFlow's own services, not a check against what Daraja actually settled.
If Payments' own stored amount were wrong from the start (a bug, not an
attack — the value comes from POS's own request), this check would not
catch it, because both sides would agree on the same wrong number. It
does catch the failure modes it was built for: a corrupted or forged
Payments response reporting success for the wrong sale, wrong tenant, or
wrong amount — proven directly in `pos.test.js:229-248`, which stubs a
"forged" Payments client reporting success for `sale_someone_else` at a
different amount and asserts the sale stays `unpaid` and
`reconcile_mismatch` is logged.

**Net position:** amount verification exists exactly once, one layer above
where the money actually moves, and it verifies internal consistency, not
provider truth. Naming that precisely is better than claiming more than
the code does.

---

## 3. POS walkthrough — claim-based commission exclusion, cross-tenant 404, and what `pos.test.js` actually proves

### Claim-based commission exclusion

The mechanism is one nullable column and two queries, not a queue or a
lock table.

`sale.commissionRunId` starts `null` at sale creation
(`sale-store.js:14`). Two operations touch it:

- **`GET /sales?status=paid&commission_run_id=X`** → `listPaid(tenantId, commissionRunId)`.
  Returns paid sales where `commission_run_id IS NULL OR commission_run_id = X`
  (`postgres-sale-store.js:66-70`; identical logic in-memory at
  `sale-store.js:31-34`). A sale claimed by a *different* run vanishes from
  every other run's view; a sale already claimed by *this* run stays
  visible — that's what lets a retried or restarted commission run safely
  re-request the same payout instead of silently missing sales it already
  saw once.
- **`POST /sales/claim`** → `claimForCommissionRun(tenantId, commissionRunId, saleIds)`.
  The Postgres version is one atomic, conditional `UPDATE`:
  ```sql
  -- postgres-sale-store.js:77-80
  UPDATE pos.sales SET commission_run_id = $2, updated_at = now()
   WHERE tenant_id = $1 AND sale_id = ANY($3::text[]) AND commission_run_id IS NULL
  ```
  The `commission_run_id IS NULL` guard means this is safe under
  concurrency by construction, not by convention — two commission runs
  racing to claim the same sale serialize on Postgres's own row lock, and
  only the first actually flips the column; the second's `WHERE` clause
  then matches zero rows for that ID. Claiming a sale already claimed by
  *this* run, or one belonging to another tenant, is a silent no-op
  (`sale-store.js:44`, `pos.test.js:332-336` — "claiming again under the
  same run is a harmless no-op").

Proven end to end in `pos.test.js:307-337` — one sale, claimed under
`run_2026-09-15`, confirmed absent from `run_2026-09-16`'s view and still
present in a repeat read of `run_2026-09-15`.

### Cross-tenant 404, not 403

Every tenant-scoped lookup in `services/pos/src/app.js` follows the same
shape — `GET /sales/:id` (line 256), `POST /sales/:id/pay` (line 208),
`POST /sales/:id/reconcile` (line 232):

```js
if (!sale || sale.tenantId !== auth.tenantId) { statusCode = 404; sendJson(res, statusCode, { error: 'not_found' }); return; }
```

A sale that exists but belongs to another tenant and a sale that doesn't
exist at all produce byte-identical responses. That's deliberate: a `403`
would leak the fact that the resource exists to a caller who has no
business knowing that. `x-service-auth` (`services/_shared/service-auth.js`)
establishes *which* tenant is calling — a `tenant_id` in the request body
is never itself authorization, it's checked against the authenticated
tenant and rejected (`403 tenant_mismatch`) or ignored as appropriate
depending on the route.

Proven in `pos.test.js:165-179` — no auth header → `401`; a signed but
*mismatched* tenant on sale creation → `403` (the creator knows their own
tenant is wrong); a valid caller reading a sale that belongs to a
*different* tenant → `404`, not `403` — the reader has no way to
distinguish "not yours" from "doesn't exist." Confirmed again generically
in `pos.test.js:250-256` for get/pay/reconcile all three.

### What `pos.test.js` actually proves, not just runs

14 tests, and each earns a specific claim rather than being generic
coverage:

| Test | What it actually proves |
|---|---|
| `configuration requires a service auth secret...` | Config fails fast at startup, not at first request |
| `an identical retry returns the same sale; changed input...is rejected` | Idempotency key semantics: same key + same body = same sale; same key + different body = `409` |
| `a tenant ID in the body alone is not authorization...` | `401` unauthenticated, `403` mismatched tenant, `404` cross-tenant read |
| `the full sale -> STK -> callback -> reconcile -> paid flow` | The entire golden path end to end, including that reconciling *before* the callback resolves correctly leaves the sale `unpaid`, and that reconciling an already-paid sale twice is a true no-op (`deepEqual`, not just same status) |
| `calling /pay twice dispatches only one STK push` | The actual claim behind the project's duplicate-dispatch guarantee (`README.md` "Caching and async"), proven at the unit level, not just under k6 load |
| `a reconciled payment that does not match the sale record...` | The forged-response scenario discussed in §2 above — this is the test that makes the amount-verification claim checkable rather than asserted |
| `claiming a sale for a commission run excludes it...` | The claim mechanism in this section, proven both directions (excluded from other runs, visible to a retry of the same run) |
| `tenant configuration: an owner can set attendants...` | Config writes are tenant-scoped |
| `tenant configuration rejects tills that reference unknown attendants...` | Referential validation on till/attendant config, not just shape validation |

What it does **not** prove: none of this runs against the deployed
ECS/RDS stack — same scope boundary as drills 1, 2, and 6 (see
`evidence/reliability-operations/README.md`). It proves the logic is
correct in the real code paths; the deployed infrastructure carrying that
logic through is proven separately, by the k6 deployed-baseline run and
the game-day drills.
