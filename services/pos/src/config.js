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
  // Cache is off unless explicitly configured. POS must stay runnable with no
  // Valkey anywhere — locally, in CI, and in any environment where the cache
  // has not been provisioned yet.
  const posCache = env.POS_CACHE ?? 'off';
  if (!['off', 'redis'].includes(posCache)) {
    throw new Error('POS_CACHE must be off or redis');
  }
  const cacheUrl = env.CACHE_URL;
  if (posCache === 'redis' && !cacheUrl) {
    throw new Error('CACHE_URL is required when POS_CACHE=redis');
  }
  // ElastiCache has transit encryption on, so the URL must be rediss://, not
  // redis://. Catching it here turns a silent connection failure that degrades
  // to Postgres forever — the cache would appear to "work", just never hit —
  // into a startup error someone actually notices.
  if (posCache === 'redis' && !cacheUrl.startsWith('rediss://') && !cacheUrl.startsWith('redis://')) {
    throw new Error('CACHE_URL must be a redis:// or rediss:// URL');
  }
  const rawCacheTtl = env.CACHE_TTL_SECONDS ?? '60';
  if (!/^\d+$/.test(rawCacheTtl) || Number(rawCacheTtl) < 1 || Number(rawCacheTtl) > 3600) {
    throw new Error('CACHE_TTL_SECONDS must be an integer between 1 and 3600');
  }

  return Object.freeze({
    host, port: Number(rawPort), paymentsBaseUrl, serviceAuthSecret, posStore, databaseUrl,
    posCache, cacheUrl, cacheTtlSeconds: Number(rawCacheTtl),
  });
}
