# Game day drill 5 — restore (real RTO/RPO, both missed narrowly; reconciliation now works)

DRI: @mercykilonzo (Reliability + operations), executed by @aine-mbabazi
against the deployed stack while closing G4.

## What was broken, and how

**This is the third attempt at a single drill run tonight, and it took
finding and fixing four separate real bugs to get a clean end-to-end
execution.** Each was found live, none was worked around:

1. **ECS JSON casing.** `drill-05-restore.mjs` read
   `networkConfiguration.awsvpcConfiguration.Subnets` /
   `.SecurityGroups` (capitalized) to build the one-off ECS task's network
   config. ECS's actual JSON casing is camelCase-first-lowercase
   (`subnets`, `securityGroups`) — confirmed directly against the live API.
   Both were `undefined`, `.join(',')` threw, the catch swallowed it into a
   "reconciliation failed" result, and the restore instance was deleted
   before the bug could be diagnosed interactively. **First run's RTO/RPO
   (1757s / 285s, both under target) are real and stand on their own, but
   reconciliation never ran.**
2. **`verify-restore.mjs` never destructured `Pool` from `pg`.** `pg`'s
   CommonJS export is `{ Pool, Client, ... }`, not a default `Pool` export.
   `new Pool(...)` threw `ReferenceError: Pool is not defined` before any
   logging happened, so the one-off ECS task's captured logs were empty —
   confirmed by reproducing the exact error locally. **Second run's RTO/RPO
   (1759s met, 411s missed) are real; reconciliation crashed again, for a
   different reason than the first.**
3. **Pretty-printed JSON broke the caller's line-picker.** `verify-restore.mjs`
   logged `JSON.stringify(result, null, 2)` (multi-line); the caller finds
   "the line starting with `{`" in the captured CloudWatch output and parses
   just that line — which, for pretty-printed JSON, is a lone `{` character.
   Found and fixed via a smoke test against the live database (comparing it
   to itself) **before** spending a third ~30-minute restore cycle on it.
4. **A full per-record dump exceeds CloudWatch's per-log-event size limit.**
   The live database now holds 2,162 `payment_attempts` rows, accumulated
   across every k6/drill run this project has done. Logging every
   reconciled record produced a JSON blob CloudWatch split across multiple
   log events; reconstructing them via `get-log-events --output text`
   corrupted the JSON with stray control characters at the split
   boundaries. Fixed by summarizing (counts + a bounded 10-record sample)
   instead of dumping the full list — found and fixed via the same smoke
   test, again before spending the real restore cycle.

Bugs 3 and 4 were caught by pointing the fixed `verify-restore.mjs` at the
**live** database twice (as both "live" and "restore" URLs) via
`run-in-vpc.sh`, deliberately avoiding a third real RDS restore until the
script was confirmed working — a ~1-minute check instead of another
~30-minute cycle.

## Timeline (UTC) — third, successful execution

| Time | Event |
|---|---|
| 22:02:24 | `restore-db-instance-to-point-in-time` issued (restore point: 21:54:21) |
| 22:02–22:32 | `creating` → `backing-up` → `modifying` (RDS PITR spends most of this in `backing-up` — expected, not stuck) |
| 22:32:57 | Restore instance `available` |
| 22:33:04 | Reconciliation step started (`run-in-vpc.sh` + `verify-restore.mjs`, inside the VPC, reusing the Payments task's IAM role/network config) |
| 22:34:34 | Reconciliation completed successfully — 2,162 payment rows compared, 0 payout rows, all 4 internal checks pass |
| 22:34:34 | Restore instance deletion issued |
| 22:34:38 | Live instance confirmed `available`, deletion protection intact, untouched throughout |

Full transcript (all three attempts, in sequence, showing exactly what
each bug looked like when it failed):
[`drill-05-transcript.jsonl`](drill-05-transcript.jsonl). Machine evidence:
[`g4-restore.json`](../g4-restore.json).

## Detected by

Not applicable in the alerting sense — this is a planned, manual drill, not
an alarm-triggered incident. Detection here means the script's own
assertions and the real AWS API responses (`DBInstanceStatus`, row counts,
per-record status comparison).

## Recovery steps

Per `docs/runbook.md#backup-and-restore`: restore into a **new** instance
(never over the live one — confirmed: `devops-g2-db` was `available`
throughout, its own `DeletionProtection` unchanged), verify row counts on
both instances, then re-check every record that was `pending` at the
restore point against current live state (step 2 — "the one that gets
skipped under pressure"). Executed and captured this time, not skipped:
2,162 payment records checked, 0 resolved since the restore point (honest
and expected — `DARAJA_MODE=fake` means nothing can resolve a payment
without a human `simulateOutcome()` call, so this exact result is what the
method's own documented substitution predicts). Restore instance deleted
after capture; the live instance was never repointed to.

## Measured RTO/RPO vs target

**RTO: 1833 seconds (30m33s) against the 1800-second (30-minute) target —
missed by 33 seconds.**
**RPO: 483 seconds (8m03s) against the 300-second (5-minute) target —
missed by 2m48s (483 − 300 = 183s over, i.e. the real replay-lag exposure
is roughly 60% higher than the design intent assumed).**

Both numbers are measured, not asserted — first time either RTO or RPO has
been converted from design intent into evidence for this project. Neither
passes. That is reported plainly rather than rounded favorably: 33 seconds
over a 30-minute target is not "essentially met," and an 8-minute RPO
against a 5-minute target is a real gap between what the runbook promises
and what RDS PITR actually delivers for this instance size and this
restore-point/wall-clock relationship.

## Pass/fail

**Not a pass, honestly reported.** All 6 mechanism checks in
`g4-restore.json` are true (new instance, RTO measured, RPO measured,
reconciliation executed and captured, restore instance deleted, live
instance untouched) — the drill executed cleanly end to end for the first
time tonight. But the runbook's own success criterion for drill 5 is RTO
and RPO **within** target plus reconciliation captured, and two of those
three are misses. This is the drill converting the recovery objectives
from "design intent" into "measured, and currently not met" — which is
what G4 asked for, even though the number is worse than hoped.

## Honest caveats

- **Two of three prior RTO/RPO measurements (attempt 1: 1757s/285s both
  met; attempt 2: 1759s met / 411s missed) are real, valid data points in
  their own right**, even though neither attempt completed reconciliation.
  All three attempts' numbers are close to each other (1757s, 1759s,
  1833s for RTO; 285s, 411s, 483s for RPO) — consistent, not a fluke of a
  single bad run. RTO clusters right around the 30-minute line; RPO trends
  upward across the three attempts, which may reflect increasing load on
  the source instance from the accumulated 2,162+ rows and the repeated
  drill activity in the same session rather than a stable baseline.
- **The reconciliation method is the same documented fake-mode
  substitution named in `verify-restore.mjs`'s own header**: "re-query
  Daraja" becomes "check whether the live database's record has since
  reached a terminal state," since `DARAJA_MODE=fake` means there is no
  external provider to actually query. All 2,162 pending payments remain
  pending — expected, since nothing in this deployment can resolve a fake
  payment without a JS-only `simulateOutcome()` call unreachable over HTTP
  (the same limitation documented for drills 1, 2, and 6).
- **The full per-record list is no longer in the evidence JSON, by
  design** — see bug 4 above. `g4-restore.json` carries counts and a
  10-record sample instead of all 2,162; the counts (`resolved_since_restore_point_count`,
  `unresolved_count`) are what make the reconciliation check meaningful at
  this scale.
- **Two RDS restore instances were created and deleted before this one**
  (attempts 1 and 2, both cleaned up immediately after their respective
  failures) — no orphaned restore instances remain; confirmed via
  `describe-db-instances` after each attempt and again after this one.
