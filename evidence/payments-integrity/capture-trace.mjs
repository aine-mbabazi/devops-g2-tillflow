#!/usr/bin/env node
// G3 trace capture: one real distributed trace for the sale -> pay ->
// callback path, and one for the scheduled Commission daily close, both
// against the DEPLOYED stack. docs/pos-spans.md documents the expected span
// tree and the X-Ray id generator/propagator choice this relies on — this
// script proves it against a live trace rather than describing it.
//
// Payment path: this process generates its own X-Ray-format trace ID and
// sends it on the initial request via the `X-Amzn-Trace-Id` header (the
// header the X-Ray propagator reads on an incoming request). Because we
// chose the trace ID ourselves, we can fetch it directly with
// `aws xray batch-get-traces` afterwards instead of searching — deterministic,
// not a best-effort match.
//
// Commission path: the scheduled task's trace ID is not something a caller
// can inject (EventBridge, not HTTP), so this triggers a real run
// (`aws ecs run-task`, the same command the runbook already documents as safe
// to re-run — commissionRunId is derived from the UTC date, so idempotent)
// and searches X-Ray for traces in that narrow, controlled time window whose
// resource attributes name the commission service.
//
// Required env: API_URL, SERVICE_AUTH_SECRET, TENANT_ID
// Commission mode additionally needs: CLUSTER (default devops-g2),
// COMMISSION_TASK_DEFINITION (default devops-g2-commission), SUBNETS,
// SECURITY_GROUPS (comma-separated — same private subnets/SG the ECS
// services use)
//
// Run:
//   node evidence/payments-integrity/capture-trace.mjs payment
//   node evidence/payments-integrity/capture-trace.mjs commission

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { signServiceAuth } from '../../services/_shared/service-auth.js';

const REGION = process.env.AWS_REGION || 'us-east-2';

function aws(args) {
  const out = execFileSync('aws', [...args, '--region', REGION, '--output', 'json'], { encoding: 'utf8' });
  return out.trim() ? JSON.parse(out) : null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) { console.error(`Missing required env var: ${name}`); process.exit(1); }
  return value;
}

// X-Ray trace ID: 1-<8 hex epoch seconds>-<24 hex random>
function newXrayTraceId() {
  const epochHex = Math.floor(Date.now() / 1000).toString(16).padStart(8, '0');
  const random = randomBytes(12).toString('hex');
  return `1-${epochHex}-${random}`;
}

function distillSegments(traces) {
  const services = new Set();
  const annotations = {};
  let segmentCount = 0;
  for (const trace of traces) {
    for (const segment of trace.Segments ?? []) {
      segmentCount += 1;
      let doc;
      try { doc = JSON.parse(segment.Document); } catch { continue; }
      if (doc.name) services.add(doc.name);
      for (const sub of doc.subsegments ?? []) {
        if (sub.name) services.add(sub.name);
      }
      if (doc.aws?.['otel.resource.service.name']) services.add(doc.aws['otel.resource.service.name']);
      Object.assign(annotations, doc.annotations ?? {});
    }
  }
  return { services: [...services], annotations, segmentCount };
}

async function capturePayment() {
  const API_URL = requireEnv('API_URL');
  const SERVICE_AUTH_SECRET = requireEnv('SERVICE_AUTH_SECRET');
  const TENANT_ID = requireEnv('TENANT_ID');

  const traceId = newXrayTraceId();
  const xrayHeader = `Root=${traceId}`;
  console.log(JSON.stringify({ event: 'trace_capture_started', target: 'payment', traceId }));

  const authHeader = () => signServiceAuth(TENANT_ID, SERVICE_AUTH_SECRET);
  const saleId = `trace-${Date.now()}`;

  const saleRes = await fetch(`${API_URL}/sales`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': saleId, 'x-service-auth': authHeader(), 'X-Amzn-Trace-Id': xrayHeader },
    body: JSON.stringify({
      tenant_id: TENANT_ID, attendant_id: 'trace-attendant',
      line_items: [{ description: 'trace capture item', quantity: 1, unit_price_minor: 15000 }],
      currency: 'KES', customer_phone: '+254700000098',
    }),
  });
  const sale = await saleRes.json();
  if (saleRes.status !== 201) throw new Error(`sale create failed: ${saleRes.status} ${JSON.stringify(sale)}`);
  console.log(JSON.stringify({ event: 'checkpoint', step: 'sale_created', saleId: sale.sale_id }));

  const payRes = await fetch(`${API_URL}/sales/${sale.sale_id}/pay`, {
    method: 'POST',
    headers: { 'x-service-auth': authHeader(), 'X-Amzn-Trace-Id': xrayHeader },
  });
  const paid = await payRes.json();
  if (payRes.status !== 202) throw new Error(`pay failed: ${payRes.status} ${JSON.stringify(paid)}`);
  console.log(JSON.stringify({ event: 'checkpoint', step: 'pay_dispatched' }));

  console.log(JSON.stringify({ event: 'waiting_for_xray_ingestion', seconds: 30 }));
  await sleep(30_000);

  const batch = aws(['xray', 'batch-get-traces', '--trace-ids', traceId]);
  const traces = batch?.Traces ?? [];
  const { services, annotations, segmentCount } = distillSegments(traces);

  const summary = {
    target: 'payment',
    trace_id: traceId,
    xray_trace_id: traceId,
    sale_id: sale.sale_id,
    trace_found: traces.length > 0,
    trace_segment_count: segmentCount,
    trace_services: services,
    trace_annotations: annotations,
    checks: [
      { check: 'sale created', ok: saleRes.status === 201 },
      { check: 'pay dispatched', ok: payRes.status === 202 },
      { check: 'trace found in X-Ray', ok: traces.length > 0 },
      { check: 'trace covers pos and payments', ok: services.some((s) => /pos/i.test(s)) && services.some((s) => /payments/i.test(s)) },
    ],
  };
  writeFileSync('evidence/payments-integrity/g3-trace-payment.json', JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ event: 'trace_capture_completed', target: 'payment', ...summary }));
}

async function captureCommission() {
  const CLUSTER = process.env.CLUSTER || 'devops-g2';
  const TASK_DEFINITION = process.env.COMMISSION_TASK_DEFINITION || 'devops-g2-commission';
  const SUBNETS = requireEnv('SUBNETS');
  const SECURITY_GROUPS = requireEnv('SECURITY_GROUPS');

  const startedAt = new Date();
  console.log(JSON.stringify({ event: 'trace_capture_started', target: 'commission', startedAt: startedAt.toISOString() }));

  const netConfig = JSON.stringify({ awsvpcConfiguration: { subnets: SUBNETS.split(','), securityGroups: SECURITY_GROUPS.split(','), assignPublicIp: 'DISABLED' } });
  const run = aws(['ecs', 'run-task', '--cluster', CLUSTER, '--task-definition', TASK_DEFINITION, '--launch-type', 'FARGATE', '--network-configuration', netConfig]);
  const taskArn = run?.tasks?.[0]?.taskArn;
  if (!taskArn) throw new Error(`run-task did not return a task: ${JSON.stringify(run)}`);
  console.log(JSON.stringify({ event: 'checkpoint', step: 'commission_task_started', taskArn }));

  aws(['ecs', 'wait', 'tasks-stopped', '--cluster', CLUSTER, '--tasks', taskArn]);
  const stoppedAt = new Date();
  const described = aws(['ecs', 'describe-tasks', '--cluster', CLUSTER, '--tasks', taskArn]);
  const exitCode = described?.tasks?.[0]?.containers?.[0]?.exitCode;
  console.log(JSON.stringify({ event: 'checkpoint', step: 'commission_task_stopped', exitCode }));

  console.log(JSON.stringify({ event: 'waiting_for_xray_ingestion', seconds: 30 }));
  await sleep(30_000);

  const summaries = aws([
    'xray', 'get-trace-summaries',
    '--start-time', String(Math.floor(startedAt.getTime() / 1000) - 10),
    '--end-time', String(Math.floor(stoppedAt.getTime() / 1000) + 10),
    '--filter-expression', 'service("commission")',
  ]);
  const traceIds = (summaries?.TraceSummaries ?? []).map((t) => t.Id);
  const batch = traceIds.length ? aws(['xray', 'batch-get-traces', '--trace-ids', traceIds.join(',')]) : { Traces: [] };
  const { services, annotations, segmentCount } = distillSegments(batch?.Traces ?? []);

  const summary = {
    target: 'commission',
    task_arn: taskArn,
    started_at: startedAt.toISOString(),
    stopped_at: stoppedAt.toISOString(),
    exit_code: exitCode,
    trace_ids: traceIds,
    trace_segment_count: segmentCount,
    trace_services: services,
    trace_annotations: annotations,
    checks: [
      { check: 'commission task ran to completion', ok: exitCode === 0 },
      { check: 'at least one trace found in the run window', ok: traceIds.length > 0 },
      { check: 'trace covers commission', ok: services.some((s) => /commission/i.test(s)) },
    ],
  };
  writeFileSync('evidence/payments-integrity/g3-trace-commission.json', JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ event: 'trace_capture_completed', target: 'commission', ...summary }));
}

const target = process.argv[2];
if (target === 'payment') {
  capturePayment().catch((error) => { console.error('TRACE CAPTURE FAILED', error); process.exit(1); });
} else if (target === 'commission') {
  captureCommission().catch((error) => { console.error('TRACE CAPTURE FAILED', error); process.exit(1); });
} else {
  console.error('usage: capture-trace.mjs <payment|commission>');
  process.exit(1);
}
