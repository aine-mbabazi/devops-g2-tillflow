import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { shutdownTelemetry, traceContext } from './telemetry.js';
import { PosClient } from './pos-client.js';
import { PaymentsClient } from './payments-client.js';

const log = (entry) => console.log(JSON.stringify({
  timestamp: new Date().toISOString(), service: 'web', ...traceContext(), ...entry,
}));

async function start() {
  try {
    const config = loadConfig();
    const posClient = new PosClient({ baseUrl: config.posBaseUrl });
    const paymentsClient = new PaymentsClient({ baseUrl: config.paymentsBaseUrl });
    const server = createApp({
      posClient, paymentsClient, serviceAuthSecret: config.serviceAuthSecret, log,
    });
    server.on('error', (error) => {
      log({ event: 'server_error', code: error.code ?? 'UNKNOWN' });
      process.exitCode = 1;
    });
    server.listen(config.port, config.host, () => {
      log({
        event: 'listening', host: config.host, port: config.port,
        posBaseUrl: config.posBaseUrl, paymentsBaseUrl: config.paymentsBaseUrl,
      });
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
          .catch((error) => log({ event: 'telemetry_shutdown_failed', message: error.message }));
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
