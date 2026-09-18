// Renders a CloudWatch alarm state change into the Slack alert contract from
// docs/alert-contract.md: environment, service, symptom, user/SLO impact,
// observed value, dashboard panel, runbook link, owner, first safe action.
//
// The per-alarm half of that contract travels in the alarm's own
// AlarmDescription as JSON (see infra/main/alarms.tf). Keeping it there rather
// than in a lookup table inside this function means an engineer adding an
// alarm cannot add one without also stating who owns it and what to do first —
// the alarm and its contract are the same Terraform resource.
//
// The webhook URL is read from Secrets Manager at runtime, never from an
// environment variable: Lambda environment variables are readable by anyone
// with lambda:GetFunctionConfiguration and are rendered into Terraform state.

// The SDK is imported lazily rather than at module load. It ships with the
// nodejs20.x runtime, so it is always present in Lambda — but importing it at
// the top would make buildMessage() unloadable anywhere the SDK is not
// installed, and buildMessage() is the part worth unit-testing (test.mjs runs
// with no node_modules at all).
const SECRET_ID = process.env.SLACK_WEBHOOK_SECRET_ID;
const ENVIRONMENT = process.env.ENVIRONMENT || 'prod';
const DASHBOARD_BASE = process.env.DASHBOARD_BASE_URL || '';
const RUNBOOK_BASE = process.env.RUNBOOK_BASE_URL || '';

// Cached across invocations on a warm container. A rotated webhook is picked
// up on the next cold start; alerting is not worth a Secrets Manager call per
// alarm, and a stale URL fails loudly rather than silently.
let cachedWebhook;

async function webhookUrl() {
  if (cachedWebhook) return cachedWebhook;
  const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
  const secrets = new SecretsManagerClient({});
  const result = await secrets.send(new GetSecretValueCommand({ SecretId: SECRET_ID }));
  const raw = (result.SecretString || '').trim();
  if (!raw) throw new Error(`${SECRET_ID} is empty — populate it before alerts can be delivered`);
  // Tolerates either a bare URL or {"url": "..."} so rotating the secret to a
  // structured form later does not break delivery.
  let url = raw;
  if (raw.startsWith('{')) {
    const parsed = JSON.parse(raw);
    url = parsed.url || parsed.webhook_url || parsed.SLACK_WEBHOOK_URL;
  }
  if (!url || !url.startsWith('https://')) throw new Error(`${SECRET_ID} does not contain an https webhook URL`);
  cachedWebhook = url;
  return url;
}

// CloudWatch states the observed value inside a prose reason, e.g.
//   "Threshold Crossed: 1 datapoint [7.0 (18/09/26 06:00:00)] was greater than the threshold (1.0)."
// The number in brackets is what an on-call engineer actually wants to read
// first, so it is pulled out; the full reason is kept as the fallback.
export function observedValue(reason) {
  const match = /\[([\d.]+)\s/.exec(reason || '');
  return match ? match[1] : (reason || 'unknown');
}

function contractFrom(description) {
  try {
    const parsed = JSON.parse(description);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {
    // An alarm created outside Terraform, or one whose description was edited
    // in the console, still delivers — it just cannot carry the full contract.
  }
  return { symptom: description || 'No description set on this alarm.' };
}

export function buildMessage(alarm) {
  const firing = alarm.NewStateValue === 'ALARM';
  const contract = contractFrom(alarm.AlarmDescription);
  const trigger = alarm.Trigger || {};
  const panel = contract.panel && DASHBOARD_BASE ? `${DASHBOARD_BASE}${contract.panel}` : contract.panel;
  const runbook = contract.runbook && RUNBOOK_BASE ? `${RUNBOOK_BASE}${contract.runbook}` : contract.runbook;

  const heading = firing
    ? `:rotating_light: FIRING — ${alarm.AlarmName}`
    : `:white_check_mark: RECOVERED — ${alarm.AlarmName}`;

  const fields = [
    ['Environment', ENVIRONMENT],
    ['Service', contract.service || 'unknown'],
    ['Owner', contract.owner || 'unassigned'],
    ['Observed', `${observedValue(alarm.NewStateReason)}${contract.unit ? ` ${contract.unit}` : ''}`],
    ['Threshold', trigger.Threshold !== undefined ? String(trigger.Threshold) : 'n/a'],
    ['Since', alarm.StateChangeTime || new Date().toISOString()],
  ];

  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: heading.slice(0, 150), emoji: true } },
    {
      type: 'section',
      fields: fields.map(([label, value]) => ({
        type: 'mrkdwn',
        text: `*${label}*\n${value}`,
      })),
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*Symptom*\n${contract.symptom || 'not stated'}` },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*User / SLO impact*\n${contract.impact || 'not stated'}` },
    },
  ];

  // A recovery notice deliberately drops the "first safe action" block. Telling
  // someone what to do about an alert that has already cleared is how a page
  // turns into noise people learn to scroll past.
  if (firing) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*First safe action*\n${contract.first_action || 'not stated'}` },
    });
  }

  const links = [];
  if (panel) links.push(`<${panel}|Dashboard panel>`);
  if (runbook) links.push(`<${runbook}|Runbook>`);
  if (links.length) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: links.join('  ·  ') }] });

  return {
    text: heading, // notification fallback for clients that do not render blocks
    attachments: [{ color: firing ? '#d13212' : '#2e7d32', blocks }],
  };
}

async function postToSlack(url, payload) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(5000),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Slack responded ${response.status}: ${body}`);
}

export async function handler(event) {
  const url = await webhookUrl();
  const records = event.Records || [];
  const failures = [];

  for (const record of records) {
    let alarm;
    try {
      alarm = JSON.parse(record.Sns.Message);
    } catch {
      // Not a CloudWatch alarm — something else publishes to this topic. Pass
      // the raw text through rather than dropping it silently.
      await postToSlack(url, { text: `:grey_question: Non-alarm message on the alerts topic:\n${record.Sns.Message}` });
      continue;
    }
    try {
      await postToSlack(url, buildMessage(alarm));
      console.log(JSON.stringify({ event: 'alert_delivered', alarm: alarm.AlarmName, state: alarm.NewStateValue }));
    } catch (error) {
      console.log(JSON.stringify({ event: 'alert_delivery_failed', alarm: alarm.AlarmName, message: error.message }));
      failures.push(alarm.AlarmName);
    }
  }

  // Throwing makes Lambda retry the SNS delivery. An alert that silently
  // failed to reach Slack is worse than a duplicate one.
  if (failures.length) throw new Error(`Failed to deliver: ${failures.join(', ')}`);
}
