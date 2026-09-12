export function loadConfig(env = process.env) {
  const rawPort = env.PORT ?? '3001';
  if (!/^\d+$/.test(rawPort) || Number(rawPort) < 1 || Number(rawPort) > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }
  const host = env.HOST ?? '127.0.0.1';
  if (!host.trim()) throw new Error('HOST must not be empty');
  const darajaMode = env.DARAJA_MODE ?? 'fake';
  if (!['fake', 'sandbox'].includes(darajaMode)) {
    throw new Error('DARAJA_MODE must be fake or sandbox');
  }
  const paymentStore = env.PAYMENT_STORE ?? 'memory';
  if (!['memory', 'postgres'].includes(paymentStore)) {
    throw new Error('PAYMENT_STORE must be memory or postgres');
  }
  const databaseUrl = env.DATABASE_URL;
  if (paymentStore === 'postgres' && !databaseUrl) {
    throw new Error('DATABASE_URL is required when PAYMENT_STORE=postgres');
  }
  const sandbox = {
    consumerKey: env.DARAJA_CONSUMER_KEY,
    consumerSecret: env.DARAJA_CONSUMER_SECRET,
    shortcode: env.DARAJA_STK_SHORTCODE,
    passkey: env.DARAJA_STK_PASSKEY,
    callbackUrl: env.DARAJA_STK_CALLBACK_URL,
    timeoutMs: Number(env.DARAJA_TIMEOUT_MS ?? '10000'),
  };
  if (darajaMode === 'sandbox' && Object.values(sandbox).some((value) => !value)) {
    throw new Error('Daraja sandbox credentials and callback URL are required when DARAJA_MODE=sandbox');
  }
  if (darajaMode === 'sandbox') {
    if (!/^\d+$/.test(sandbox.shortcode)) throw new Error('DARAJA_STK_SHORTCODE must be numeric');
    if (!Number.isInteger(sandbox.timeoutMs) || sandbox.timeoutMs < 1000 || sandbox.timeoutMs > 30000) {
      throw new Error('DARAJA_TIMEOUT_MS must be between 1000 and 30000');
    }
    let callback;
    try { callback = new URL(sandbox.callbackUrl); } catch { throw new Error('DARAJA_STK_CALLBACK_URL must be a URL'); }
    if (callback.protocol !== 'https:') throw new Error('DARAJA_STK_CALLBACK_URL must use HTTPS');
  }
  return Object.freeze({ host, port: Number(rawPort), darajaMode, paymentStore, databaseUrl, sandbox });
}
