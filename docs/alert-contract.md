# Slack alert contract

DRI: @mercykilonzo.

Every alert TillFlow sends to Slack carries the same nine fields. The contract
exists because the alternative — raw CloudWatch JSON in a channel — tells an
on-call engineer that a threshold was crossed and nothing about what to do,
which is how a team learns to mute a channel.

## The nine fields

| Field | Where it comes from | Why it is required |
|---|---|---|
| **Environment** | `ENVIRONMENT` on the notifier Lambda, from `local.common_tags.environment` | One channel will eventually carry more than one environment. Without this, the first question in every thread is "is this prod?" |
| **Service** | `service` in the alarm description | Routes the alert to a human without anyone reading the metric name. |
| **Symptom** | `symptom` | What is wrong in user terms, not metric terms. "POS is returning 5xx to attendants", not "HTTPCode_Target_5XX_Count > 5". |
| **User / SLO impact** | `impact` | Whether to get out of bed. An alert that cannot answer this should not be an alert. |
| **Observed value** | Parsed out of CloudWatch's `NewStateReason` | "7" is actionable; "threshold crossed" is not. |
| **Threshold** | `Trigger.Threshold` on the alarm event | Observed alone has no scale. 7 of what, against what? |
| **Dashboard panel** | `panel` + `DASHBOARD_BASE_URL` | One click to the time series, not a hunt through the console. |
| **Runbook link** | `runbook` + `RUNBOOK_BASE_URL` | Deep-links to the matching section of `docs/runbook.md`. |
| **Owner** | `owner` | Exactly one handle. "The team" is not an owner. |
| **First safe action** | `first_action` | The single next step that cannot make things worse. On a money system this is the most important field in the message — most of them say some version of "do not retry". |

## How it is carried

The per-alarm half of the contract lives in the alarm's own `alarm_description`
as JSON, in `infra/main/alarms.tf`:

```hcl
alarm_description = jsonencode({
  service      = "payments"
  owner        = "@cheshari-pearl"
  symptom      = "Daraja callbacks are taking more than 60s to reach a terminal state (p95)."
  impact       = "Sales stay pending at the till after the customer has paid..."
  unit         = "milliseconds (p95)"
  panel        = ""
  runbook      = "#payments-callback-lag"
  first_action = "Run the reconciliation path rather than retrying payments..."
})
```

`infra/main/lambda/slack-notifier/index.mjs` parses it and renders the Slack
blocks.

This placement is the design decision worth defending. The alternative — a
lookup table inside the notifier mapping alarm names to contract text — would
let someone add an alarm without adding its contract, and the alert would fire
into Slack with no owner and no first action. Keeping the contract in the alarm
resource means the two cannot be added separately: they are the same Terraform
resource, reviewed in the same PR, by the same CODEOWNER.

An alarm created outside Terraform, or one whose description was edited in the
console, still delivers — it just renders "not stated" in the missing fields.
Degrading visibly beats dropping the message.

## Firing and recovery

Both transitions notify. `alarm_actions` and `ok_actions` point at the same SNS
topic, and the notifier renders recovery in green with the heading `RECOVERED`.

Recovery messages deliberately **omit the first-safe-action block**. Telling
someone what to do about an alert that has already cleared is how a page turns
into noise.

## The webhook

`SLACK_WEBHOOK_URL` lives in Secrets Manager as `devops-g2/slack-webhook` and is
read at runtime by the notifier. It is **never** in Git, Terraform state, or
build logs — the Terraform resource declares the secret but deliberately has no
`aws_secretsmanager_secret_version`, because writing the value through Terraform
would put it in both plan output and state.

It is populated once, out of band:

```bash
aws secretsmanager put-secret-value \
  --secret-id devops-g2/slack-webhook \
  --secret-string 'https://hooks.slack.com/services/...'
```

An environment variable on the Lambda was rejected for the same reason: Lambda
environment variables are readable by anyone holding
`lambda:GetFunctionConfiguration`, and they are rendered into Terraform state.

## Alerting on the alerting

`devops-g2-alert-delivery-failing` watches the notifier's own error count, so a
broken alert path is itself an alert.

That alarm routes through the path it is reporting on, which is a real and
deliberate limitation: if the notifier is completely down, this alert cannot be
delivered either. The mitigation is the weekly manual verification in
[the runbook](runbook.md#alert-delivery-failing) — a synthetic alarm message
published straight to the topic — rather than pretending the loop is closed.

## What is deliberately not alerted

- **CPU and memory on their own.** They appear on the dashboard as saturation
  context and in one loose RDS alarm, but they do not page. Nobody can act on
  "CPU is 71%"; they can act on "POS is slow".
- **4xx rates.** A client sending bad requests is not TillFlow failing. The SLI
  definitions in `docs/slo-error-budgets.md` exclude invalid requests from the
  denominator for the same reason.
- **Individual task restarts.** ECS replacing a task is normal operation. The
  symptom worth alerting on is the load balancer having no healthy target, which
  is what `devops-g2-*-unhealthy-targets` covers.
