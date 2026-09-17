import { loadConfig } from './config.js';
import { runDailyClose, reconcilePendingLedgerEntries } from './daily-close.js';
import { InMemoryCommissionLedger } from './ledger.js';
import { PostgresCommissionLedger } from './postgres-ledger.js';
import { PaymentsClient } from './payments-client.js';
import { PosClient } from './pos-client.js';

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
  let ledger = new InMemoryCommissionLedger();
  let pool;
  if (config.ledgerStore === 'postgres') {
    const { Pool } = await import('pg');
    pool = new Pool({ connectionString: config.databaseUrl });
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

main().catch((error) => {
  log({ event: 'daily_close_failed', message: error.message });
  process.exitCode = 1;
});
