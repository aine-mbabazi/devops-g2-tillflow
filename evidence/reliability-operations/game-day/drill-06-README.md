# Game day drill 6 — abandoned payment / DLQ recovery (never run before this pass)

DRI: @mercykilonzo (Reliability + operations), executed by @aine-mbabazi
against the deployed stack while closing G4.

## What was broken, and how

Created one real payment (`POST /payments`, tenant `load-tenant`, KES 150)
against the live API Gateway and deliberately withheld its callback. The
intent: prove a payment TillFlow can never resolve on its own reaches the
real `devops-g2-reconciliation-dlq-not-empty` alarm and a real Slack
delivery, then recovers through the runbook's documented first safe action
(`docs/runbook.md#reconciliation-dlq`) — never `set-alarm-state`.

**A real defect surfaced getting there, not just the mechanism working as
described.** The script's original comment asserted that an abandoned
payment reaches the reconciliation queue "through nothing but ordinary API
calls." That's wrong for the current code: `app.js` only calls
`reconciliationQueue.enqueue()` from the `catch` block around
`initiateStkPush` — i.e. on a *dispatch failure*. `FakeDarajaClient` never
throws for valid input (`DARAJA_MODE=fake` on the deployed task), so a
plain abandoned payment never gets enqueued at all. Confirmed live: both
queues sat at 0 messages and the alarm had only ever been `OK`, several
minutes after the first payment was created. This is the identical
structural blocker documented for drills 1 & 2 against the deployed edge.

**Fix applied, consistent with the "no code change to `fake-client.js`"
decision already made for drills 1 & 2:** manually seed the real
`devops-g2-reconciliation` queue with the exact message shape `app.js`
itself sends on a dispatch failure
(`{"type":"payment","id":"<paymentId>"}`), pointed at the payment just
created over real HTTP. Everything downstream is genuine — the actually
deployed consumer, real SQS redelivery, the real DLQ, the real CloudWatch
alarm, real Slack delivery.

**A second real defect surfaced on the first live run:** the script's
`tryParse()` called `JSON.parse()` directly on raw CloudWatch log lines.
Lambda's console-log format prefixes each line with
`<timestamp>\t<requestId>\t<level>\t` before the JSON payload, so every
parse attempt threw, was swallowed, and the Slack-delivery match never
found — even though delivery genuinely happened 8 seconds after the alarm
fired. The 10-minute poll timed out waiting for evidence that already
existed. Fixed by slicing to the first `{` before parsing. **This exact
function is duplicated in `drill-03-platform-failure.mjs`**, which was
about to be re-run next for G4 item 4 — fixed there too before it could
waste the same 10 minutes.

## Timeline (UTC)

| Time | Event |
|---|---|
| 19:29:03 | Payment created (`payment_7489c426-...`), callback withheld |
| 19:29:04 | Reconciliation message manually seeded onto the real queue |
| 19:34:06 | Message visible in the real DLQ (5 redeliveries, ~5 min) |
| 19:36:09 | `devops-g2-reconciliation-dlq-not-empty` OK → ALARM, confirmed via real alarm history |
| 19:36:16 | Slack notifier delivered the firing alert (confirmed after-the-fact from raw CloudWatch Logs; the live poll missed it due to the `tryParse` bug above) |
| 19:46:10 | First script run exits with the Slack-confirmation timeout (`DRILL FAILED WITH EXCEPTION`) — DLQ message and alarm left open |
| ~19:46–20:02 | `tryParse` bug diagnosed and fixed in both drill-06 and drill-03; resume script written to finish from step 5 against the same real payment rather than create a third one |
| 20:02:11 | Resume started |
| 20:02:14 | DLQ message received, confirmed to match `payment_7489c426-...`, deleted (not redriven) |
| 20:08:09 | `devops-g2-reconciliation-dlq-not-empty` ALARM → OK, confirmed via real alarm history |
| 20:08:40 | Slack notifier delivered the recovery alert, confirmed live |

Full transcript: [`drill-06-transcript.jsonl`](drill-06-transcript.jsonl)
(both the original run and the resume, appended in sequence). Machine
evidence: [`g3-alarm-firing.json`](../g3-alarm-firing.json).

## Detected by

The real `devops-g2-reconciliation-dlq-not-empty` CloudWatch alarm, off the
real `ApproximateNumberOfMessagesVisible` metric on `devops-g2-reconciliation-dlq`
— no `set-alarm-state` at any point. Delivered to Slack by the real
`devops-g2-slack-notifier` Lambda.

## Recovery steps

Per `docs/runbook.md#reconciliation-dlq`: read the message, confirm what it
is before touching anything, and — since this is a known, permanently
unresolvable case in `DARAJA_MODE=fake` rather than a transient failure —
delete it rather than redrive it (redriving would just refill the DLQ).
Exactly what the drill did.

## Measured RTO/RPO vs target

Not the RTO/RPO the runbook defines (this isn't a service outage or data
loss event). The relevant timing here is alarm responsiveness:
- **ALARM to OK, from the moment the underlying condition was actually
  fixed:** 5m55s (20:02:14 delete → 20:08:09 OK) — consistent with the
  alarm's 5-minute evaluation period, not a stuck alarm.
- **DLQ landing to alarm firing:** 2m03s (19:34:06 → 19:36:09).
- **Alarm firing to Slack delivery:** 7 seconds.
- **Total wall-clock ALARM open (19:36:09 → 20:08:09): 32 minutes** — but
  ~16 of those minutes (19:46–20:02) were tooling downtime while the
  `tryParse` bug was diagnosed and fixed, not incident response time. That
  gap is named here rather than hidden in the number.

## Pass/fail

**Pass.** All 7 checks in `g3-alarm-firing.json` are true: payment
dispatched, message reached the real DLQ, alarm fired from a real
condition, Slack delivered the firing alert, the DLQ message was confirmed
as this drill's own payment before deletion, the alarm recovered to `OK`,
and Slack delivered the recovery alert.

## Honest caveats

- **The reconciliation-queue seed step is a documented substitution, not
  the organic path.** `DARAJA_MODE=fake` gives no HTTP-reachable way to
  make a dispatch fail, so the one message that would organically have
  come from a real `provider_dispatch_unconfirmed` was sent by hand, in
  the exact shape `app.js` produces. Every step after that injection point
  — consumer behavior, redelivery count, DLQ landing, the alarm, Slack — is
  the real deployed mechanism reacting to a real queue state, the same
  class of substitution `verify-restore.mjs` already names for its own
  fake-mode limitation.
- **The first live run genuinely failed and is preserved in the transcript
  rather than deleted and re-run cleanly.** The tryParse bug is real,
  confirmed independently by pulling the raw CloudWatch Logs event by hand
  and finding the delivery the script's own poll missed.
- **Recovery was resumed as a separate script (`/tmp/drill-06-resume.mjs`,
  not committed — it's a one-off continuation, not a reusable drill) against
  the same real payment and DLQ message**, rather than the original script
  restarting cleanly end-to-end, because the underlying condition (alarm
  open, DLQ message unresolved) needed resolving promptly rather than left
  open for a second full ~15-minute run. `drill-06-abandoned-payment.mjs`
  itself is fixed and will run start-to-finish cleanly on a future
  invocation — this run's split into two halves is a one-time consequence
  of finding the bug mid-drill, not a property of the fixed script.
- One extra orphaned test payment from the first (typo) attempt on 2026-09-28
  (`payment_627c71f5-...`) sits `pending` forever in the live DB — harmless,
  same shape as other drill/k6 test data, no cleanup performed.
