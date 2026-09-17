export function loadConfig(env = process.env) {
  const posBaseUrl = env.POS_BASE_URL ?? 'http://127.0.0.1:3002';
  const paymentsBaseUrl = env.PAYMENTS_BASE_URL ?? 'http://127.0.0.1:3001';
  for (const [name, value] of [['POS_BASE_URL', posBaseUrl], ['PAYMENTS_BASE_URL', paymentsBaseUrl]]) {
    try { new URL(value); } catch { throw new Error(`${name} must be a URL`); }
  }
  const serviceAuthSecret = env.SERVICE_AUTH_SECRET;
  if (!serviceAuthSecret) {
    throw new Error('SERVICE_AUTH_SECRET is required — it authenticates Commission to POS and Payments');
  }
  const tenantIds = (env.TENANT_IDS ?? '').split(',').map((id) => id.trim()).filter(Boolean);
  if (tenantIds.length === 0) throw new Error('TENANT_IDS must list at least one tenant to close (comma-separated)');
  const ledgerStore = env.LEDGER_STORE ?? 'memory';
  if (!['memory', 'postgres'].includes(ledgerStore)) {
    throw new Error('LEDGER_STORE must be memory or postgres');
  }
  const databaseUrl = env.DATABASE_URL;
  if (ledgerStore === 'postgres' && !databaseUrl) {
    throw new Error('DATABASE_URL is required when LEDGER_STORE=postgres');
  }
  return Object.freeze({ posBaseUrl, paymentsBaseUrl, serviceAuthSecret, tenantIds, ledgerStore, databaseUrl });
}
