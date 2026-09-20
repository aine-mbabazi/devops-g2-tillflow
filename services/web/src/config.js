export function loadConfig(env = process.env) {
  const rawPort = env.PORT ?? '3003';
  if (!/^\d+$/.test(rawPort) || Number(rawPort) < 1 || Number(rawPort) > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }
  const host = env.HOST ?? '127.0.0.1';
  if (!host.trim()) throw new Error('HOST must not be empty');
  const posBaseUrl = env.POS_BASE_URL ?? 'http://127.0.0.1:3002';
  try { new URL(posBaseUrl); } catch { throw new Error('POS_BASE_URL must be a URL'); }
  const paymentsBaseUrl = env.PAYMENTS_BASE_URL ?? 'http://127.0.0.1:3001';
  try { new URL(paymentsBaseUrl); } catch { throw new Error('PAYMENTS_BASE_URL must be a URL'); }
  const serviceAuthSecret = env.SERVICE_AUTH_SECRET;
  if (!serviceAuthSecret) {
    throw new Error('SERVICE_AUTH_SECRET is required — it verifies a caller before web forwards their request downstream');
  }

  return Object.freeze({
    host, port: Number(rawPort), posBaseUrl, paymentsBaseUrl, serviceAuthSecret,
  });
}
