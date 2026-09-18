import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { shutdownTelemetry, traceContext } from './telemetry.js';
import { PaymentsClient } from './payments-client.js';
import { InMemorySaleStore } from './sale-store.js';
import { PostgresSaleStore } from './postgres-sale-store.js';
import { InMemoryTenantStore } from './tenant-store.js';
import { PostgresTenantStore } from './postgres-tenant-store.js';
import { NoopCache, RedisCache } from './cache.js';
import { CachingTenantStore } from './caching-tenant-store.js';

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

    // Cache-aside over tenant config only. Nothing about money is cached — a
    // stale payment status is how a double charge happens, and the read volume
    // on those paths does not justify the risk. See ADR 0004.
    let cache = new NoopCache();
    if (config.posCache === 'redis') {
      const { createClient } = await import('redis');
      const client = createClient({ url: config.cacheUrl });
      // A cache that cannot connect must not take POS down with it, so the
      // error handler logs rather than throws. Without it, node-redis emits an
      // unhandled 'error' event and kills the process.
      client.on('error', (error) => log({ event: 'cache_client_error', message: error.message }));
      await client.connect().catch((error) => log({ event: 'cache_connect_failed', message: error.message }));
      cache = new RedisCache(client, log);
      tenantStore = new CachingTenantStore({
        inner: tenantStore, cache, ttlSeconds: config.cacheTtlSeconds, log,
      });
    }
    const server = createApp({ paymentsClient, serviceAuthSecret: config.serviceAuthSecret, saleStore, tenantStore, log });
    server.on('error', (error) => {
      log({ event: 'server_error', code: error.code ?? 'UNKNOWN' });
      process.exitCode = 1;
    });
    server.listen(config.port, config.host, () => {
      log({ event: 'listening', host: config.host, port: config.port, posStore: config.posStore, posCache: config.posCache });
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
          .finally(() => Promise.all([cache.close(), pool?.end()])
            .catch(() => { process.exitCode = 1; }));
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
