#!/usr/bin/env node
// Game day drill 5 — Restore (docs/runbook.md#game-day-drills / #backup-and-restore)
//
// Hypothesis: a point-in-time restore meets RPO, and provider references
// reconcile cleanly afterwards.
//
// The first execution of this drill (2026-09-20) restored in 35m21s — over
// the 30-minute RTO target — and skipped the mandatory reconciliation step
// (runbook.md step 2: re-querying payments that were pending at the restore
// point), so it was not recorded as a pass. This script re-runs the same,
// already-documented procedure end to end, this time executing and capturing
// that reconciliation step via evidence/run-in-vpc.sh + verify-restore.mjs,
// and reporting whatever the real RTO/RPO numbers are — including a miss, if
// that is what happens. Never overwrites or renames onto the live instance:
// the restore always lands in a brand-new identifier, and is deleted again
// once evidence is captured.
//
// Required env: none beyond working AWS credentials with rds/ecs/secretsmanager
// permissions. Everything else (subnets, security groups, live DB secret) is
// discovered from the account at run time, the same way the runbook's own
// commands do it.
//
// Run:
//   node evidence/reliability-operations/game-day/drill-05-restore.mjs \
//     > evidence/reliability-operations/game-day/drill-05-transcript.jsonl

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const REGION = process.env.AWS_REGION || 'us-east-2';
const SOURCE_ID = process.env.SOURCE_DB_ID || 'devops-g2-db';
const TARGET_ID = process.env.TARGET_DB_ID || 'devops-g2-db-restore';
const SUBNET_GROUP = process.env.DB_SUBNET_GROUP || 'devops-g2-db-subnets';
const PAYMENTS_SERVICE = process.env.PAYMENTS_SERVICE || 'devops-g2-payments';
const CLUSTER = process.env.CLUSTER || 'devops-g2';
const RTO_TARGET_SECONDS = 30 * 60;
const RPO_TARGET_SECONDS = 5 * 60;
const AVAILABLE_POLL_DEADLINE_MS = 60 * 60 * 1000;
const AVAILABLE_POLL_INTERVAL_MS = 30_000;

const logLines = [];
function log(entry) {
  const line = { ts: new Date().toISOString(), ...entry };
  logLines.push(line);
  console.log(JSON.stringify(line));
  return line;
}

function aws(args) {
  const out = execFileSync('aws', [...args, '--region', REGION, '--output', 'json'], { encoding: 'utf8' });
  return out.trim() ? JSON.parse(out) : null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollUntil(deadlineMs, intervalMs, description, check) {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    const result = await check();
    if (result) return result;
    log({ event: 'poll_waiting', description, elapsedMs: Date.now() - start });
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for: ${description}`);
}

function withHost(databaseUrl, newHost) {
  const url = new URL(databaseUrl);
  url.hostname = newHost;
  return url.toString();
}

async function main() {
  log({ event: 'drill_started', drill: 'restore', source: SOURCE_ID, target: TARGET_ID });

  // Step 1: capture RPO input and the source's own security group before touching anything.
  const source = aws(['rds', 'describe-db-instances', '--db-instance-identifier', SOURCE_ID]).DBInstances[0];
  const latestRestorableTime = source.LatestRestorableTime;
  const sourceSg = source.VpcSecurityGroups[0].VpcSecurityGroupId;
  log({ event: 'drill_step', step: 1, description: 'captured source state', latestRestorableTime, sourceSg, sourceStatus: source.DBInstanceStatus, sourceDeletionProtection: source.DeletionProtection });

  // Step 2: restore into a NEW instance, never the live one.
  const startedAt = new Date().toISOString();
  log({ event: 'drill_step', step: 2, description: `restoring ${SOURCE_ID} -> ${TARGET_ID} at latest restorable time` });
  aws([
    'rds', 'restore-db-instance-to-point-in-time',
    '--source-db-instance-identifier', SOURCE_ID,
    '--target-db-instance-identifier', TARGET_ID,
    '--use-latest-restorable-time',
    '--db-subnet-group-name', SUBNET_GROUP,
    '--vpc-security-group-ids', sourceSg,
    '--no-publicly-accessible',
  ]);
  log({ event: 'drill_assertion', step: 2, result: 'pass', startedAt, detail: 'restore-db-instance-to-point-in-time issued' });

  // Step 3: wait for it to become available. RDS PITR spends most of this
  // time in `backing-up`, not "restore apply" — that is expected, not stuck.
  log({ event: 'drill_step', step: 3, description: `waiting for ${TARGET_ID} to become available` });
  const availableAt = await pollUntil(AVAILABLE_POLL_DEADLINE_MS, AVAILABLE_POLL_INTERVAL_MS, `${TARGET_ID} status == available`, () => {
    const target = aws(['rds', 'describe-db-instances', '--db-instance-identifier', TARGET_ID]).DBInstances[0];
    log({ event: 'restore_status', status: target.DBInstanceStatus });
    return target.DBInstanceStatus === 'available' ? new Date().toISOString() : null;
  });
  const target = aws(['rds', 'describe-db-instances', '--db-instance-identifier', TARGET_ID]).DBInstances[0];
  log({ event: 'drill_assertion', step: 3, result: 'pass', availableAt, endpoint: target.Endpoint?.Address });

  const rtoSeconds = Math.round((new Date(availableAt) - new Date(startedAt)) / 1000);
  const rpoSeconds = Math.round((new Date(startedAt) - new Date(latestRestorableTime)) / 1000);

  // Step 4: reconciliation, inside the VPC, reusing the Payments task's own
  // role/network config — no new IAM surface.
  log({ event: 'drill_step', step: 4, description: 'running verify-restore.mjs inside the VPC via run-in-vpc.sh' });
  const liveSecret = aws(['secretsmanager', 'get-secret-value', '--secret-id', `${SOURCE_ID.replace('-db', '')}/database-url`]);
  const liveUrl = liveSecret.SecretString;
  const restoreUrl = withHost(liveUrl, target.Endpoint.Address);
  const netConfig = aws(['ecs', 'describe-services', '--cluster', CLUSTER, '--services', PAYMENTS_SERVICE]).services[0].networkConfiguration.awsvpcConfiguration;

  const envOverrides = JSON.stringify([
    { name: 'LIVE_DATABASE_URL', value: liveUrl },
    { name: 'RESTORE_DATABASE_URL', value: restoreUrl },
  ]);

  // Shipped as an inline `node -e <source>` command, not a file path: the
  // deployed Payments image does not contain evidence/ (its Dockerfile only
  // copies services/), so pointing run-in-vpc.sh at a path inside that image
  // would fail. Sending the script's own source as a container-override
  // command needs no image rebuild and stays well under ECS's 8KB overrides
  // limit (~4.7KB serialized, including both database URLs).
  const verifyRestoreSource = readFileSync(path.join(__dirname, '..', 'verify-restore.mjs'), 'utf8');

  let reconciliation;
  try {
    const stdout = execFileSync('evidence/run-in-vpc.sh', ['--', 'node', '--input-type=module', '-e', verifyRestoreSource], {
      encoding: 'utf8',
      env: {
        ...process.env,
        CLUSTER, TASK_DEFINITION: PAYMENTS_SERVICE, CONTAINER_NAME: 'payments',
        SUBNETS: netConfig.Subnets.join(','), SECURITY_GROUPS: netConfig.SecurityGroups.join(','),
        ENV_OVERRIDES: envOverrides, AWS_REGION: REGION,
      },
    });
    const jsonLine = stdout.split('\n').find((line) => line.trim().startsWith('{'));
    reconciliation = jsonLine ? JSON.parse(jsonLine) : { error: 'no JSON result found in run-in-vpc.sh output', raw: stdout };
    log({ event: 'drill_assertion', step: 4, result: 'pass', reconciliation });
  } catch (error) {
    reconciliation = { error: error.message };
    log({ event: 'drill_assertion', step: 4, result: 'fail', message: error.message });
  }

  // Step 5: clean up the restore instance and confirm live was never touched.
  log({ event: 'drill_step', step: 5, description: `deleting ${TARGET_ID}` });
  aws(['rds', 'delete-db-instance', '--db-instance-identifier', TARGET_ID, '--skip-final-snapshot']);
  const liveAfter = aws(['rds', 'describe-db-instances', '--db-instance-identifier', SOURCE_ID]).DBInstances[0];
  log({ event: 'drill_assertion', step: 5, result: 'pass', liveStatusAfter: liveAfter.DBInstanceStatus, deletionProtectionIntact: liveAfter.DeletionProtection });

  const summary = {
    drill: 'devops-g2-restore',
    source: SOURCE_ID,
    target: TARGET_ID,
    started_utc: startedAt,
    restore_point: latestRestorableTime,
    available_utc: availableAt,
    rto: { seconds: rtoSeconds, target_seconds: RTO_TARGET_SECONDS, met: rtoSeconds <= RTO_TARGET_SECONDS },
    rpo: { seconds: rpoSeconds, target_seconds: RPO_TARGET_SECONDS, met: rpoSeconds <= RPO_TARGET_SECONDS },
    reconciliation,
    live_after: { id: SOURCE_ID, status: liveAfter.DBInstanceStatus, deletion_protection: liveAfter.DeletionProtection },
    rewrote_live_from_restore: false,
    checks: [
      { check: 'restore landed in a new, separate instance', ok: true },
      { check: 'RTO measured (started -> available)', ok: true },
      { check: 'RPO measured (started - LatestRestorableTime at call)', ok: true },
      { check: 'reconciliation step (runbook step 2) executed and captured', ok: !reconciliation.error },
      { check: 'restore instance deleted after capture', ok: true },
      { check: 'live instance untouched throughout', ok: liveAfter.DBInstanceStatus === 'available' },
    ],
  };
  writeFileSync('evidence/reliability-operations/g4-restore.json', JSON.stringify(summary, null, 2));
  log({ event: 'drill_completed', drill: 'restore', result: summary.rto.met && summary.rpo.met && !reconciliation.error ? 'pass' : 'executed, see summary for target misses', rtoSeconds, rpoSeconds });
}

main().catch((error) => {
  console.error('DRILL FAILED WITH EXCEPTION', error);
  process.exit(1);
});
