# Game day drills 1 & 2 — re-run, and why they stay local-only

DRI: @mercykilonzo (Reliability + operations), re-run by @aine-mbabazi while
closing G4/G5.

## What was broken, and how

**Drill 1 — uncertain payment.** A wrapped Daraja client throws
`DARAJA_TIMEOUT` on the first `initiateStkPush` call only. The drill POSTs a
sale, confirms the payment stays `pending` (never declined) and that
`provider_dispatch_unconfirmed` is logged, re-POSTs the identical sale with
the same idempotency key and confirms zero additional dispatches, then plays
the DLQ operator step by hand (`store.transition()`) the way
`docs/runbook.md#reconciliation-dlq` prescribes.

**Drill 2 — callback replay.** Drives a real terminal callback to
`succeeded`, replays the identical callback (confirms it is a true no-op —
still exactly one `callback_processed`), then sends a reordered callback that
disagrees with the stored state. Confirms the disagreement is logged as
`callback_conflict` and the stored state is left untouched.

Both run against the real `app.js` / `payment-store.js` /
`reconciliation-queue.js` code, over real HTTP, on an ephemeral local
server (`127.0.0.1`, in-memory store) — only the Daraja transport is a
double.

## Timeline (UTC)

| Time | Drill | Event |
|---|---|---|
| 2026-09-28T19:17:23Z | 1 | Completed, result: pass |
| 2026-09-28T19:17:27Z | 2 | Completed, result: pass |

Full transcripts: [`drill-01-transcript.jsonl`](drill-01-transcript.jsonl),
[`drill-02-transcript.jsonl`](drill-02-transcript.jsonl).

## Detected by

Not applicable — these are synthetic, self-contained drills with their own
assertions (5 for drill 1, 3 for drill 2), not incidents detected by
production monitoring.

## Recovery steps

Drill 1: the DLQ / "query Daraja directly" procedure, played by hand —
confirmed the automated reconciler correctly refuses to guess
(`processMessage`'s `providerRequestId` guard), then resolved through
`store.transition()`, the same primitive the automated reconciler itself
uses once it has a confirmed answer.

Drill 2: no recovery action needed — the system's own conflict-preserving
behavior (log, don't overwrite) is the correct outcome under test.

## Measured RTO/RPO vs target

Not applicable to either drill — neither exercises an outage or data loss.
Both are correctness-under-replay proofs, not recovery-time proofs.

## Pass/fail

Both pass, exactly as the first run (2026-09-20). All 5 assertions pass for
drill 1, all 3 for drill 2.

## Honest caveat — why these did not move to the deployed edge

The plan for this pass was to re-run drills 1 and 2 against the deployed
stack instead of a local server, the same way drill 6 exercises the real API
Gateway. That turned out to be structurally blocked, not just unattempted:

- `FakeDarajaClient.initiateStkPush` (`services/payments/src/daraja/fake-client.js`)
  always resolves immediately with `pending` — there is no input over HTTP
  that makes it throw `DARAJA_TIMEOUT`. Drill 1's timeout is only reachable
  today by wrapping the client in-process, which a real deployed ECS task
  does not allow.
- `FakeDarajaClient#simulateOutcome`, the only way to move a fake payment to
  a terminal `succeeded`/`failed` state, is JS-only and unreachable over
  HTTP. Drill 6's own header comment confirms this independently: a payment
  created against the deployed edge "can NEVER be resolved through the
  public callback endpoint." Drill 2 needs a terminal payment to replay a
  callback against, so it inherits the same block.

Both are direct consequences of `DARAJA_MODE=fake` on the deployed Payments
task (`infra/main/payments-task.tf`) — the same limitation named in the
brief ("Payments runs in fake Daraja mode: no real callbacks, sales may not
reach paid"), not a gap in either drill script.

**Decision:** rather than add a test-only trigger to `fake-client.js` to
force these states over HTTP (a Payments-owned code change needing its own
PR, review and deploy), this pass re-ran the existing local version of both
drills for a second confirmation and documents the limitation here plainly.
Drills 1 and 2 remain proven against the real production code paths, just
not against the deployed infrastructure — the same scope boundary the
k6 local-only profiles and the original 2026-09-20 run already carried,
recorded in `evidence/reliability-operations/README.md`.
