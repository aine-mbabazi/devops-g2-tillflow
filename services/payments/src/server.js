import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { FakeDarajaClient } from './daraja/fake-client.js';

const log = (entry) => console.log(JSON.stringify({
  timestamp: new Date().toISOString(), service: 'payments', ...entry,
}));

try {
  const config = loadConfig();
  const server = createApp({ darajaClient: new FakeDarajaClient(), log });
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
    server.close(() => clearTimeout(deadline));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
} catch (error) {
  log({ event: 'startup_error', message: error.message });
  process.exitCode = 1;
}
