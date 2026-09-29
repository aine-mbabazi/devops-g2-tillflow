import { SpanStatusCode, trace } from '@opentelemetry/api';
import { loadConfig } from './config.js';
import { runDailyClose, reconcilePendingLedgerEntries } from './daily-close.js';
import { InMemoryCommissionLedger } from './ledger.js';
import { PostgresCommissionLedger } from './postgres-ledger.js';
import { PaymentsClient } from './payments-client.js';
import { PosClient } from './pos-client.js';
import { shutdownTelemetry } from './telemetry.js';

const log = (entry) => console.log(JSON.stringify({
  timestamp: new Date().toISOString(), service: 'commission', ...entry,
}));

// One run per UTC day by default, so an EventBridge retry or a manual rerun
// on the same day reuses the same commissionRunId — and therefore the same
// deterministic idempotency keys in Payments — rather than minting a new
// run and risking a second payout.
function defaultCommissionRunId(now = new Date()) {
  return `close:${now.toISOString().slice(0, 10)}`;
}

async function main() {
  const config = loadConfig();
  const paymentsClient = new PaymentsClient({ baseUrl: config.paymentsBaseUrl, serviceAuthSecret: config.serviceAuthSecret });
  const posClient = new PosClient({ baseUrl: config.posBaseUrl, serviceAuthSecret: config.serviceAuthSecret });
  const commissionRunId = process.env.COMMISSION_RUN_ID ?? defaultCommissionRunId();
  trace.getActiveSpan()?.setAttributes({
    'commission.run_id': commissionRunId, 'commission.tenant_ids': config.tenantIds.join(','),
  });
  let ledger = new InMemoryCommissionLedger();
  let pool;
  if (config.ledgerStore === 'postgres') {
    const { Pool } = await import('pg');
    // RDS Postgres 16's default parameter group enforces rds.force_ssl; see
    // services/pos/src/server.js for why rejectUnauthorized: false is used
    // instead of an sslmode connection-string param.
    pool = new Pool({ connectionString: config.databaseUrl, ssl: { rejectUnauthorized: false } });
    ledger = new PostgresCommissionLedger(pool);
  }

  try {
    // Resolve yesterday's still-pending payouts (or earlier ones this same
    // process retried) before starting today's close, so the ledger reflects
    // real terminal outcomes rather than staying stuck on 'pending' forever.
    await reconcilePendingLedgerEntries({ ledger, paymentsClient, log });

    for (const tenantId of config.tenantIds) {
      log({ event: 'daily_close_started', tenantId, commissionRunId });
      const results = await runDailyClose({ tenantId, commissionRunId, posClient, paymentsClient, ledger, log });
      log({ event: 'daily_close_completed', tenantId, commissionRunId, payoutCount: results.length });
    }
  } finally {
    await pool?.end().catch(() => {});
  }
}

// One root span for the whole run, so the calls to POS and Payments appear
// as its children in a single trace rather than as disconnected roots.
trace.getTracer('commission').startActiveSpan('commission.daily_close', async (span) => {
  try {
    await main();
  } catch (error) {
    span.recordException(error);
    span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
    log({ event: 'daily_close_failed', message: error.message });
    process.exitCode = 1;
  } finally {
    span.end();
    // Flush before the process exits, or the spans never reach the sidecar.
    await shutdownTelemetry().catch(() => {});
  }
});
