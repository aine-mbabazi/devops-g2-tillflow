import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { shutdownTelemetry, traceContext } from './telemetry.js';
import { PaymentsClient } from './payments-client.js';
import { InMemorySaleStore } from './sale-store.js';
import { PostgresSaleStore } from './postgres-sale-store.js';
import { InMemoryTenantStore } from './tenant-store.js';
import { PostgresTenantStore } from './postgres-tenant-store.js';

const log = (entry) => console.log(JSON.stringify({
  timestamp: new Date().toISOString(), service: 'pos', ...traceContext(), ...entry,
}));

async function start() {
  try {
    const config = loadConfig();
    const paymentsClient = new PaymentsClient({ baseUrl: config.paymentsBaseUrl, serviceAuthSecret: config.serviceAuthSecret });
    let saleStore = new InMemorySaleStore();
    let tenantStore = new InMemoryTenantStore();
    let pool;
    if (config.posStore === 'postgres') {
      const { Pool } = await import('pg');
      pool = new Pool({ connectionString: config.databaseUrl });
      saleStore = new PostgresSaleStore(pool);
      tenantStore = new PostgresTenantStore(pool);
    }
    const server = createApp({ paymentsClient, serviceAuthSecret: config.serviceAuthSecret, saleStore, tenantStore, log });
    server.on('error', (error) => {
      log({ event: 'server_error', code: error.code ?? 'UNKNOWN' });
      process.exitCode = 1;
    });
    server.listen(config.port, config.host, () => {
      log({ event: 'listening', host: config.host, port: config.port, posStore: config.posStore });
    });

    let stopping = false;
    const shutdown = () => {
      if (stopping) return;
      stopping = true;
      log({ event: 'shutdown' });
      const deadline = setTimeout(() => { server.closeAllConnections(); process.exit(1); }, 10000);
      deadline.unref();
      server.close(() => {
        clearTimeout(deadline);
        // Flush buffered spans before the process exits; a collector outage
        // must not prevent shutdown, so a failure is logged and ignored.
        shutdownTelemetry()
          .catch((error) => log({ event: 'telemetry_shutdown_failed', message: error.message }))
          .finally(() => pool?.end().catch(() => { process.exitCode = 1; }));
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
