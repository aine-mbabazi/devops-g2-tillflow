#!/usr/bin/env node
// Restore verification (docs/runbook.md#backup-and-restore, step 2 — the step
// flagged as "the one that gets skipped under pressure"), run inside the VPC
// against both the live database and a point-in-time restore, via
// evidence/run-in-vpc.sh so it can reach RDS's private subnet without opening
// any new network path.
//
// What "re-query Daraja" means in this deployment: DARAJA_MODE=fake means
// there is no external provider to re-query — the closest honest analog is
// checking whether the LIVE database's record for a payment that was
// `pending` at the restore point has since reached a terminal state, since in
// fake mode that live record *is* the source of truth a real Daraja query
// would otherwise stand in for. That substitution is named explicitly in the
// output rather than left implicit.
//
// Required env: LIVE_DATABASE_URL, RESTORE_DATABASE_URL
// Writes its result as JSON to stdout; the caller (run-in-vpc.sh) captures it
// via CloudWatch Logs.
//
// Run inline, not as a file path: the deployed Payments image only contains
// services/payments and services/_shared (see its Dockerfile), not this
// evidence/ directory, so drill-05-restore.mjs ships this file's own source
// as a `node --input-type=module -e <source>` command override rather than
// pointing at a path that does not exist inside the container. That also
// means the working directory at container start (the image's /app) cannot
// be relied on for bare-specifier resolution, so `pg` is loaded via
// createRequire against a known path inside the image instead of a plain
// `import 'pg'`, which would otherwise depend on being run from
// services/payments/.

import { createRequire } from 'node:module';

const require = createRequire('/app/services/payments/package.json');
const pg = require('pg');

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(JSON.stringify({ event: 'verify_restore_failed', reason: `missing env var ${name}` }));
    process.exit(1);
  }
  return value;
}

async function rowCount(pool, table) {
  const { rows } = await pool.query(`SELECT count(*)::int AS count FROM ${table}`);
  return rows[0].count;
}

async function pendingAtRestorePoint(pool, table, idColumn) {
  const { rows } = await pool.query(
    `SELECT ${idColumn} AS id, tenant_id, status, provider_request_id, created_at FROM ${table} WHERE status = 'pending'`,
  );
  return rows;
}

async function main() {
  const liveUrl = requireEnv('LIVE_DATABASE_URL');
  const restoreUrl = requireEnv('RESTORE_DATABASE_URL');

  const live = new Pool({ connectionString: liveUrl, connectionTimeoutMillis: 5000, query_timeout: 10000 });
  const restore = new Pool({ connectionString: restoreUrl, connectionTimeoutMillis: 5000, query_timeout: 10000 });

  const result = { checked_at: new Date().toISOString(), row_counts: {}, reconciliation: {}, checks: [] };

  try {
    for (const [key, table, idColumn] of [
      ['payments', 'payments.payment_attempts', 'payment_id'],
      ['payouts', 'payments.payout_attempts', 'payout_id'],
    ]) {
      const liveCount = await rowCount(live, table);
      const restoreCount = await rowCount(restore, table);
      result.row_counts[key] = { live: liveCount, restore: restoreCount, delta: liveCount - restoreCount };
      result.checks.push({ check: `${key} row count captured on both instances`, ok: true });
    }

    for (const [key, table, idColumn] of [
      ['payments', 'payments.payment_attempts', 'payment_id'],
      ['payouts', 'payments.payout_attempts', 'payout_id'],
    ]) {
      const pendingAtRestore = await pendingAtRestorePoint(restore, table, idColumn);
      const reconciled = [];
      for (const record of pendingAtRestore) {
        const { rows } = await live.query(`SELECT status FROM ${table} WHERE ${idColumn} = $1`, [record.id]);
        const liveStatus = rows[0]?.status ?? 'not_found_on_live';
        reconciled.push({
          id: record.id,
          tenant_id: record.tenant_id,
          status_at_restore_point: record.status,
          live_status_now: liveStatus,
          resolved_since_restore_point: liveStatus !== 'pending' && liveStatus !== 'not_found_on_live',
        });
      }
      result.reconciliation[key] = {
        pending_at_restore_point: pendingAtRestore.length,
        method: 'DARAJA_MODE=fake — re-queried against the live database\'s current record for each id, the fake-mode analog of re-querying the provider directly',
        records: reconciled,
      };
      result.checks.push({ check: `every ${key} record pending at the restore point was re-checked against live state`, ok: true });
    }

    console.log(JSON.stringify(result, null, 2));
    process.exitCode = 0;
  } catch (error) {
    console.error(JSON.stringify({ event: 'verify_restore_failed', message: error.message }));
    process.exitCode = 1;
  } finally {
    await live.end().catch(() => {});
    await restore.end().catch(() => {});
  }
}

main();
