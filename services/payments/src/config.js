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
    b2cShortcode: env.DARAJA_B2C_SHORTCODE,
    b2cInitiatorName: env.DARAJA_B2C_INITIATOR_NAME,
    b2cSecurityCredential: env.DARAJA_B2C_SECURITY_CREDENTIAL,
    b2cResultUrl: env.DARAJA_B2C_RESULT_URL,
    b2cTimeoutUrl: env.DARAJA_B2C_TIMEOUT_URL,
  };
  if (darajaMode === 'sandbox' && Object.values(sandbox).some((value) => !value)) {
    throw new Error('Daraja sandbox credentials and callback URLs (STK and B2C) are required when DARAJA_MODE=sandbox');
  }
  if (darajaMode === 'sandbox') {
    if (!/^\d+$/.test(sandbox.shortcode)) throw new Error('DARAJA_STK_SHORTCODE must be numeric');
    if (!/^\d+$/.test(sandbox.b2cShortcode)) throw new Error('DARAJA_B2C_SHORTCODE must be numeric');
    if (!Number.isInteger(sandbox.timeoutMs) || sandbox.timeoutMs < 1000 || sandbox.timeoutMs > 30000) {
      throw new Error('DARAJA_TIMEOUT_MS must be between 1000 and 30000');
    }
    let callback;
    try { callback = new URL(sandbox.callbackUrl); } catch { throw new Error('DARAJA_STK_CALLBACK_URL must be a URL'); }
    if (callback.protocol !== 'https:') throw new Error('DARAJA_STK_CALLBACK_URL must use HTTPS');
    for (const [name, value] of [['DARAJA_B2C_RESULT_URL', sandbox.b2cResultUrl], ['DARAJA_B2C_TIMEOUT_URL', sandbox.b2cTimeoutUrl]]) {
      let url;
      try { url = new URL(value); } catch { throw new Error(`${name} must be a URL`); }
      if (url.protocol !== 'https:') throw new Error(`${name} must use HTTPS`);
    }
  }
  return Object.freeze({ host, port: Number(rawPort), darajaMode, paymentStore, databaseUrl, sandbox });
}
