# Post-rebuild Slack test: the watchdog's own 19-hour self-triggering loop (29 Sep 2026)

DRI: @mercykilonzo (Reliability + operations), against the deployed stack
after G5.

## What happened

After G5's destroy → rebuild, `devops-g2/slack-webhook` came back empty —
Terraform never versions this secret, by design, so it has to be populated
out of band after every rebuild that recreates it. Nobody had done that yet
when `devops-g2-alert-delivery-failing` (the watchdog that alarms if the
Slack notifier stops delivering) evaluated for the first time.

| Time (EAT / UTC) | Event |
|---|---|
| 03:35 / 00:35 | `devops-g2-alert-delivery-failing` created, `INSUFFICIENT_DATA` → `OK` |
| 03:36 / 00:36 | First `OK` → `ALARM`: its own notification attempt failed on the empty webhook secret |
| 03:36–22:36 | Flapping `ALARM` (~19 min) / `OK` (~1 min) on a ~20-minute cycle, **19 hours straight** |
| 19:35:23 / (same) UTC | Test fire on `devops-g2-payments-5xx` (`set-alarm-state`): `alert_delivered` logged |
| 19:36:17 UTC | Watchdog `RECOVERED` — first successful delivery since 00:36 UTC |
| 19:36:45 UTC | `devops-g2-payments-5xx` `RECOVERED`, delivered |
| 22:36 EAT / 19:36 UTC | Watchdog's own alarm history shows its last `ALARM` → `OK`, loop ends |

**Every alert in the account was silent for the full 19-hour window.** No
Slack message was seen by anyone — including from the one alarm whose job
was to say delivery was broken.

## Root cause: a self-triggering loop

The watchdog exists to catch a silently-failing notifier. Its own
`ALARM`/`OK` transitions are delivered through that identical notifier. When
Slack delivery is genuinely broken, the watchdog's attempt to report that is
broken by the same mechanism — so instead of surfacing the outage once, it
re-evaluates on its next period, fails to notify again, and re-enters
`ALARM`. The ~20-minute cadence in the table above is that loop, not a
flaky signal.

## Fix and verification

A new webhook for `#devops-group-2` was created and stored in
`devops-g2/slack-webhook` (the previous one was rotated after accidental
exposure, unrelated to this incident). Verified by deliberately firing and
clearing a real alarm:

- `devops-g2-payments-5xx` forced to `ALARM` via `set-alarm-state` →
  `alert_delivered` at **19:35:23 UTC** (`notifier-log.txt`) →
  `01-firing-payments-5xx-test.png`.
- Forced back to `OK` → `alert_delivered` at **19:36:45 UTC**, `RECOVERED`
  in the alarm history → `03-recovered-payments-5xx.png`.
- The watchdog itself transitioned `ALARM` → `OK` (`RECOVERED`) at
  **19:36:17 UTC**, once delivery worked again, without any manual
  intervention on the watchdog itself → `02-recovered-alert-delivery-failing.png`.

## Follow-ups

- **Route `devops-g2-alert-delivery-failing` to a separate, non-Slack SNS
  topic (email).** This is the one alarm for which sharing a channel with
  the thing it monitors can never work — it has to survive the exact
  failure it exists to catch.
- **Make an empty webhook secret fail loudly at deploy/apply time**, rather
  than silently accepting it and only discovering the gap once an alarm
  actually needs to fire.

## Files

- `alarm-history-alert-delivery-failing.txt` — full `DescribeAlarmHistory`
  output for the watchdog, 113 state transitions across the 19-hour loop.
- `alarm-history-payments-5xx.txt` — state history for the test alarm used
  to verify the fix.
- `notifier-log.txt` — Lambda notifier logs showing the three
  `alert_delivered` events that confirm delivery was restored.
- `01-firing-payments-5xx-test.png`, `02-recovered-alert-delivery-failing.png`,
  `03-recovered-payments-5xx.png` — Slack screenshots for each event above.

See also [`docs/scar-log.md`](../../../../docs/scar-log.md) (2026-09-29
entry) and the G5 evidence doc's updated Slack-webhook note:
[`evidence/reliability-operations/g5-destroy-rebuild.md`](../../g5-destroy-rebuild.md).
