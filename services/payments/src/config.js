export function loadConfig(env = process.env) {
  const rawPort = env.PORT ?? '3001';
  if (!/^\d+$/.test(rawPort) || Number(rawPort) < 1 || Number(rawPort) > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }
  const host = env.HOST ?? '127.0.0.1';
  if (!host.trim()) throw new Error('HOST must not be empty');
  const darajaMode = env.DARAJA_MODE ?? 'fake';
  if (darajaMode !== 'fake') {
    throw new Error('Only DARAJA_MODE=fake is implemented; sandbox integration comes later');
  }
  const paymentStore = env.PAYMENT_STORE ?? 'memory';
  if (!['memory', 'postgres'].includes(paymentStore)) {
    throw new Error('PAYMENT_STORE must be memory or postgres');
  }
  const databaseUrl = env.DATABASE_URL;
  if (paymentStore === 'postgres' && !databaseUrl) {
    throw new Error('DATABASE_URL is required when PAYMENT_STORE=postgres');
  }
  return Object.freeze({ host, port: Number(rawPort), darajaMode, paymentStore, databaseUrl });
}
