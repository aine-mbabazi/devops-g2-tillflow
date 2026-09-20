# Individual defence outlines — 6 minutes each

The brief scores this at 30 of 100, individually: *"explain your design,
trade-offs, own PRs, failure behavior and proof; then diagnose one cross-system
scenario. No primary area, no material contribution, or no credible defence caps
the individual score at 59 regardless of the group result."*

These are **outlines, not scripts**. Each one is structured around the four
things the brief asks for, with the evidence to open on screen at each beat. The
DRI for each area owns their own outline and should edit it into their own
words — a defence read off someone else's page is exactly what "no credible
defence" means.

## How to use the timings

Six minutes is short. The common failure is spending four minutes on
architecture and running out of time before the proof, which is the half that
scores. Every outline below front-loads a claim and reaches live evidence by
minute 3.

**Assessment rule to keep in mind throughout:** *evidence beats screenshots;
reproducibility beats explanation.* Do not describe what a test proves — run it,
or have its output already open.

---

# 1. @aine-mbabazi — Product + POS + Web, Platform + delivery

## 0:00–1:00 · The claim

TillFlow is a multi-tenant POS where **tenant isolation is enforced by
signature, not by request body**. A tenant ID in a payload is never
authorization.

Open: `services/_shared/service-auth.js`.

## 1:00–2:30 · Design and the trade-offs you chose

- **Sale state and idempotency.** The sale's own ID is the idempotency key sent
  to Payments — already unique per sale, stable across retries. A POS restart or
  a duplicate `/pay` cannot dispatch a second STK push. (`services/pos/src/app.js`,
  the `sale.paymentId` branch.)
- **Amounts in integer minor units.** Never floats. This is the money bug that
  does not announce itself.
- **Two health endpoints, deliberately asymmetric.** POS's target group polls
  `/ready` (dependency-aware — a database outage drains it); Payments' polls
  `/health` (liveness only). Reasoning is in `infra/main/payments-service.tf`:
  at `desired_count = 1`, a dependency-aware probe does not drain a task, it
  *replaces* it, and every task shares one database — so a Postgres outage would
  crash-loop the whole service for the duration of the outage.
- **Single-AZ RDS and a single NAT gateway** (ADR 0002). A cost trade, stated
  and accepted: an AZ outage exceeds RTO. Say this before you are asked.

## 2:30–4:00 · Your PRs

Walk two, not ten. Suggested: the RDS/schema migration work, and the API
Gateway + VPC Link retarget (#46) — including *why* it went missing (stacked on
#22's branch, merged into an orphan). Owning a process failure out loud reads as
competence.

## 4:00–5:00 · Failure behavior and proof

Run it, do not describe it:

```bash
cd services/pos && npm test    # 22/22
```

Name the specific test: *"the full sale → STK → callback → reconcile → paid
flow"* is a true end-to-end integration test through POS, a live Payments
server, and the fake Daraja adapter.

Then: `terraform plan` on a clean tree showing no drift.

## 5:00–6:00 · Cross-system scenario

**"An attendant reports a sale stuck unpaid for ten minutes. Where do you look,
in what order, and what do you refuse to do?"**

1. The sale exists in POS and has a `payment_id` → POS did its job.
2. Payments has the attempt in `pending` → the dispatch happened.
3. `callback_lag_ms` on the Grafana panel → is this one payment or all of them?
4. **Refuse to retry the payment.** Reconciliation is the only sanctioned path;
   a manual retry is how a customer gets charged twice.

---

# 2. @cheshari-pearl — Payments + integrity, Commission

## 0:00–1:00 · The claim

**A timeout is not a decline.** Every uncertain state in TillFlow resolves
through reconciliation against Daraja, never through a retry — and the code is
structured so that a retry *cannot* create a second charge even if someone tries.

## 1:00–2:30 · Design and the trade-offs

- **Idempotency at two levels.** A `(tenant_id, idempotency_key)` unique
  constraint, plus a *partial* unique index allowing only one active attempt per
  sale (`status IN ('pending','succeeded')`). Failed attempts stay in the audit
  history and can be retried with a fresh key. Explain why the partial index is
  the interesting one.
- **Callbacks are never trusted.** An inbound callback triggers a *query* to
  Daraja; the query's answer is what transitions state. A callback whose outcome
  contradicts stored terminal state is logged as `callback_conflict` and the
  stored state is preserved, not overwritten.
- **Commission never calls Daraja.** Enforced structurally, not by convention:
  `commission.test.js` scans every file in `services/commission/src` for a
  `daraja` import and fails the suite if one exists. This is a hard blocker in
  the brief — show the test, not the design doc.
- **Sale claiming.** The bug you found and fixed yourself: two daily closes would
  both calculate commission on the same sales, and because each run has its own
  `commissionRunId`, idempotency did not catch it — different runs meant
  different keys meant a second, legitimate-looking payout. Fixed by having POS
  track `commission_run_id` per sale.

That last one is the strongest thing you can say in six minutes: *you found a
money bug in your own design and closed it with a regression test.*

## 2:30–4:00 · Your PRs

#28 (callbacks, reconciliation, B2C, the Commission worker) and #43 (runtime IAM
+ the payments migrations COPY). For #43, be precise about the diagnosis:
`migrate.js` resolves `../migrations` relative to `src/`, and the Dockerfile only
copied `src` — so the migration task failed with `ENOENT`.

## 4:00–5:00 · Failure behavior and proof

```bash
cd services/payments && npm test    # 29/29
cd services/commission && npm test  #  9/9
```

Point at `evidence/payments-integrity/README.md` — it maps every acceptance
scenario in `docs/payment-contract.md` to the named test that proves it. That
table is the single best artifact any member has; use it.

Be equally clear about the gap: **not yet run against the real Daraja sandbox**,
only the deterministic fake adapter, per the brief's own CI rule.

## 5:00–6:00 · Cross-system scenario

**"A callback arrives twice, out of order, while the daily close is running.
What happens to the money?"**

One legal transition (the replay is a no-op — no second `callback_processed`),
one ledger effect, and a trace that explains the duplicate. If the close already
claimed the sale, the second run excludes it. Walk the state table in
`docs/commission-payout-contract.md`.

---

# 3. @mercykilonzo — Reliability + operations, CI/CD + golden path

## 0:00–1:00 · The claim

Every alert TillFlow sends names an owner and a first safe action — and on a
money system, **most of those actions are "do not retry"**. An alert that cannot
say what to do next is noise, and noise is how a team learns to mute a channel.

Open a rendered Slack alert.

## 1:00–2:30 · Design and the trade-offs

- **The contract lives in the alarm, not in the notifier.** `alarm_description`
  carries the nine fields as JSON; the Lambda renders them. The alternative — a
  lookup table inside the function — would let someone add an alarm without a
  contract. Here they are the same Terraform resource, reviewed in the same PR.
- **Symptom alarms page; saturation alarms do not.** CPU and memory are
  dashboard context. Nobody can act on "CPU is 71%"; they can act on "POS is
  returning 5xx to attendants".
- **Burn-rate alerting, with the simplification named.** Fast burn at 14.4x
  freezes releases; slow burn at 6x does not page at all. Google's scheme pairs
  each long window with a short one to stop an alarm latching; this uses the OK
  transition instead. That is weaker — say so before you are asked, and say why:
  six more alarms on a two-week project.
- **`treat_missing_data` is set per alarm, not globally.** Every service alarm
  is `notBreaching` (idle periods are normal here). The synthetic probe is
  `breaching` — a probe that stopped running is indistinguishable from a system
  that is down.
- **The webhook is never in Terraform state.** The secret is declared with no
  `secret_version`; the value is written out of band. Writing it through
  Terraform would put it in plan output *and* state.

## 2:30–4:00 · Your PRs

The reliability pack (alarms, notifier, probe, dashboards, k6, runbook), and the
OIDC trust-policy fix that unblocked the POS release workflow — which is also an
entry in `docs/scar-log.md` with a root cause and a lesson, not just a fix.

## 4:00–5:00 · Failure behavior and proof

Open `evidence/reliability-operations/k6/baseline.json`. The number that matters
is not the latency — it is `tillflow_duplicate_dispatch: 0` across ~77,000
requests. Every k6 iteration pays a sale and immediately pays it again; a second
`202` would be a double dispatch.

**State the limitation before you are asked:** those runs are local, in-memory,
on one machine — no ALB, no RDS, no network. What they prove is *shape*
(correctness under concurrency, no drift over 16 minutes, no dropped iterations),
not the deployed envelope. `docs/capacity-model.md` says exactly this, and what
it would take to measure the real ceiling.

Then show a firing and a recovery Slack message side by side.

## 5:00–6:00 · Cross-system scenario

**"Slack is quiet, the dashboard is green, and a tenant says sales have not gone
through all morning. What failed?"**

The answer is the point of the whole area: *silence is not health*. Work
through it:

1. Every service alarm is `treat_missing_data = notBreaching` — zero traffic
   looks identical to zero errors.
2. So the first check is the **synthetic probe**, the only signal that
   distinguishes "nobody is using it" from "nobody can reach it".
3. Then the **business panel**: sales recorded vs payments dispatched. A gap
   there is a product failure that every infrastructure metric reports as
   healthy.
4. Then **alert delivery itself** — if the notifier is down, the channel is quiet
   for a reason that has nothing to do with the system being well.

Naming the fourth one unprompted is the strongest finish available here: it is
the failure mode of your own design, and you built the weekly manual check
because of it.
