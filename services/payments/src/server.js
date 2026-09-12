import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { FakeDarajaClient } from './daraja/fake-client.js';
import { InMemoryPaymentStore } from './payment-store.js';
import { PostgresPaymentStore } from './postgres-payment-store.js';

const log = (entry) => console.log(JSON.stringify({
  timestamp: new Date().toISOString(), service: 'payments', ...entry,
}));

async function start() {
  try {
  const config = loadConfig();
  let paymentStore = new InMemoryPaymentStore();
  let pool;
  if (config.paymentStore === 'postgres') {
    const { Pool } = await import('pg');
    pool = new Pool({ connectionString: config.databaseUrl });
    paymentStore = new PostgresPaymentStore(pool);
  }
  const server = createApp({ darajaClient: new FakeDarajaClient(), paymentStore, log });
  server.on('error', (error) => {
    log({ event: 'server_error', code: error.code ?? 'UNKNOWN' });
    process.exitCode = 1;
  });
  server.listen(config.port, config.host, () => {
    log({ event: 'listening', ...config });
  });

  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    log({ event: 'shutdown' });
    const deadline = setTimeout(() => {
      server.closeAllConnections();
      process.exit(1);
    }, 10000);
    deadline.unref();
    server.close(() => {
      clearTimeout(deadline);
      pool?.end().catch(() => { process.exitCode = 1; });
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
