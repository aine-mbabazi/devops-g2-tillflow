// External synthetic probe, as a plain scheduled Lambda.
//
// This replaces an aws_synthetics_canary, which cannot exist in this account:
// the Terraform provider enforces run_config.memory_in_mb >= 960, and this
// account's Lambda quota caps MemorySize at 512. Those two cannot both be
// satisfied, and a quota increase is a support request, not a code change.
//
// What is kept is the part the brief actually asks for: a one-minute probe that
// runs OUTSIDE the VPC, over the public internet, through API Gateway — so it
// exercises the same path a real client takes rather than a shortcut into the
// private subnets. What is lost is the Synthetics console's screenshots and HAR
// files, which this system never needed; its checks are JSON API responses.
//
// It publishes SuccessPercent to TillFlow/synthetics, which is what
// devops-g2-synthetic-probe-failing alarms on. The alarm treats missing data as
// breaching, so a probe that stops running is indistinguishable from an outage
// — which is the entire point of having one.

import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';

const cw = new CloudWatchClient({});

const BASE_URL = process.env.PROBE_BASE_URL;
const NAMESPACE = 'TillFlow/synthetics';
const PROBE_NAME = process.env.PROBE_NAME || 'devops-g2-probe';

// Deliberately unauthenticated endpoints only. The probe holds no service-auth
// secret: a credential sitting in a function that runs every minute forever is
// a credential that eventually leaks, and /health plus /ready already answer
// what the SLI asks — is the service up, and is its database reachable.
const CHECKS = [
  { name: 'payments-health', path: '/health', expect: 200, body: { status: 'ok' } },
  { name: 'payments-ready', path: '/ready', expect: 200, body: { status: 'ready' } },
];

async function runCheck(check) {
  const url = `${BASE_URL}${check.path}`;
  const started = Date.now();

  const response = await fetch(url, {
    method: 'GET',
    headers: { 'User-Agent': 'tillflow-synthetic-probe' },
    signal: AbortSignal.timeout(10000),
  });
  const elapsed = Date.now() - started;
  const text = await response.text();

  if (response.status !== check.expect) {
    throw new Error(`${check.name}: expected ${check.expect}, got ${response.status} — ${text.slice(0, 200)}`);
  }

  // A 200 with the wrong body is a real failure mode here: API Gateway answers
  // 200 with its own error payload when a VPC Link integration is broken, so
  // status alone would report a broken gateway as healthy.
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${check.name}: 200 but body was not JSON — ${text.slice(0, 200)}`);
  }
  for (const [key, value] of Object.entries(check.body)) {
    if (parsed[key] !== value) {
      throw new Error(`${check.name}: expected ${key}="${value}", got "${parsed[key]}"`);
    }
  }

  return elapsed;
}

export async function handler() {
  if (!BASE_URL) throw new Error('PROBE_BASE_URL is not set — the probe has no target');

  const failures = [];
  let totalMs = 0;

  // Every check runs even after one fails. Stopping at the first error reports
  // "payments is down" when the real story is "payments is up but its database
  // is not", and those have different first actions.
  for (const check of CHECKS) {
    try {
      totalMs += await runCheck(check);
      console.log(JSON.stringify({ event: 'probe_check_passed', check: check.name }));
    } catch (error) {
      failures.push(error.message);
      console.log(JSON.stringify({ event: 'probe_check_failed', check: check.name, message: error.message }));
    }
  }

  const successPercent = ((CHECKS.length - failures.length) / CHECKS.length) * 100;

  // Published before any throw: a failed run must still report 0, otherwise the
  // alarm would see missing data and could not tell a failing probe from one
  // that never ran. Both are bad, but they are different incidents.
  await cw.send(new PutMetricDataCommand({
    Namespace: NAMESPACE,
    MetricData: [
      {
        MetricName: 'SuccessPercent',
        Dimensions: [{ Name: 'ProbeName', Value: PROBE_NAME }],
        Value: successPercent,
        Unit: 'Percent',
        Timestamp: new Date(),
      },
      {
        MetricName: 'Duration',
        Dimensions: [{ Name: 'ProbeName', Value: PROBE_NAME }],
        Value: totalMs,
        Unit: 'Milliseconds',
        Timestamp: new Date(),
      },
    ],
  }));

  console.log(JSON.stringify({ event: 'probe_complete', successPercent, durationMs: totalMs }));

  if (failures.length) throw new Error(failures.join(' | '));
  return 'ok';
}
