export function loadConfig(env = process.env) {
  const rawPort = env.PORT ?? '3002';
  if (!/^\d+$/.test(rawPort) || Number(rawPort) < 1 || Number(rawPort) > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }
  const host = env.HOST ?? '127.0.0.1';
  if (!host.trim()) throw new Error('HOST must not be empty');
  const paymentsBaseUrl = env.PAYMENTS_BASE_URL ?? 'http://127.0.0.1:3001';
  try { new URL(paymentsBaseUrl); } catch { throw new Error('PAYMENTS_BASE_URL must be a URL'); }
  const serviceAuthSecret = env.SERVICE_AUTH_SECRET;
  if (!serviceAuthSecret) {
    throw new Error('SERVICE_AUTH_SECRET is required — it authenticates POS to the Payments API');
  }
  const posStore = env.POS_STORE ?? 'memory';
  if (!['memory', 'postgres'].includes(posStore)) {
    throw new Error('POS_STORE must be memory or postgres');
  }
  const databaseUrl = env.DATABASE_URL;
  if (posStore === 'postgres' && !databaseUrl) {
    throw new Error('DATABASE_URL is required when POS_STORE=postgres');
  }
  return Object.freeze({ host, port: Number(rawPort), paymentsBaseUrl, serviceAuthSecret, posStore, databaseUrl });
}
