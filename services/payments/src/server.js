import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { FakeDarajaClient } from './daraja/fake-client.js';
import { DarajaSandboxClient } from './daraja/sandbox-client.js';
import { InMemoryPaymentStore } from './payment-store.js';
import { PostgresPaymentStore } from './postgres-payment-store.js';
import { InMemoryPayoutStore } from './payout-store.js';
import { PostgresPayoutStore } from './postgres-payout-store.js';
import { createReconciliationQueue } from './reconciliation-queue.js';
import { createSqsQueueClient } from './sqs-client.js';
import { shutdownTelemetry, traceContext } from './telemetry.js';

const log = (entry) => console.log(JSON.stringify({
  timestamp: new Date().toISOString(), service: 'payments', ...traceContext(), ...entry,
}));

async function start() {
  try {
  const config = loadConfig();
  let paymentStore = new InMemoryPaymentStore();
  let payoutStore = new InMemoryPayoutStore();
  let pool;
  if (config.paymentStore === 'postgres') {
    const { Pool } = await import('pg');
    // Both bounds matter under a network partition, where packets are dropped
    // rather than refused: without them a query waits forever, its pooled
    // connection is never released, and the pool drains to nothing — which
    // would take out every endpoint, not just the one that issued the query.
    // query_timeout is the one that tears the connection down client-side;
    // statement_timeout would not help, since the server never receives it.
    pool = new Pool({
      connectionString: config.databaseUrl,
      connectionTimeoutMillis: 2000,
      query_timeout: 2000,
    });
    paymentStore = new PostgresPaymentStore(pool);
    payoutStore = new PostgresPayoutStore(pool);
  }
  const darajaClient = config.darajaMode === 'sandbox'
    ? new DarajaSandboxClient(config.sandbox)
    : new FakeDarajaClient();
  let reconciliationQueue;
  let reconciliationController;
  if (config.reconciliationQueueUrl) {
    const queueClient = createSqsQueueClient({ region: config.awsRegion });
    reconciliationQueue = createReconciliationQueue({ queueClient, queueUrl: config.reconciliationQueueUrl, log });
    reconciliationController = new AbortController();
    reconciliationQueue
      .run({ paymentStore, payoutStore, darajaClient, signal: reconciliationController.signal })
      .catch((error) => log({ event: 'reconciliation_consumer_crashed', message: error.message }));
  }
  const server = createApp({ darajaClient, serviceAuthSecret: config.serviceAuthSecret, paymentStore, payoutStore, log, reconciliationQueue });
  server.on('error', (error) => {
    log({ event: 'server_error', code: error.code ?? 'UNKNOWN' });
    process.exitCode = 1;
  });
  server.listen(config.port, config.host, () => {
    // Never spread the whole config: it carries SERVICE_AUTH_SECRET,
    // DATABASE_URL, and Daraja sandbox credentials.
    log({ event: 'listening', host: config.host, port: config.port, darajaMode: config.darajaMode, paymentStore: config.paymentStore });
  });

  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    log({ event: 'shutdown' });
    reconciliationController?.abort();
    const deadline = setTimeout(() => {
      server.closeAllConnections();
      process.exit(1);
    }, 10000);
    deadline.unref();
    // Order matters: drain in-flight requests, then flush their spans, then
    // drop the pool. Flushing before the drain loses the traces most worth
    // having when a shutdown goes wrong.
    server.close(() => {
      clearTimeout(deadline);
      shutdownTelemetry()
        .catch(() => {})
        .finally(() => { pool?.end().catch(() => { process.exitCode = 1; }); });
    });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  } catch (error) {
    log({ event: 'startup_error', message: error.message });
    process.exitCode = 1;
  }
}

start();
