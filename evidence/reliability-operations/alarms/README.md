# Alarm fired and delivered: commission close failure (28 Sep 2026)

A real failure on the deployed stack, not a simulation. A Commission run started for trace capture
failed because `TENANT_IDS` was empty (`var.tenant_ids` defaulted to `""`).

| Time (UTC) | Event |
|---|---|
| 12:33:34 | Commission task logs `daily_close_failed` |
| 12:34:49 | `devops-g2-commission-close-failed` moves OK -> ALARM (+75 s) |
| 12:34:56 | Slack notifier logs `alert_delivered` (+7 s) |

82 seconds from failure to Slack. The delivered message (`commission-close-failed-slack.png`) carries
the full alert contract: environment, service, owner, observed vs threshold, since, symptom,
user/SLO impact and first safe action. This was the alarm's first ALARM transition since it was
created (OK since 20 Sep), because the nightly schedule had never been enabled.

Files: `commission-close-failed-history.txt` (alarm state history),
`commission-close-failed-slack-notifier.txt` (delivery log), `commission-close-failed-slack.png`.

Root cause and fix: `tenant_ids` now defaults to `load-tenant`, and the nightly schedule
(`cron(0 2 * * ? *)` UTC, 05:00 EAT) is enabled, as its own comment always intended.
