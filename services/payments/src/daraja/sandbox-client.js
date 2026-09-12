const SANDBOX_BASE_URL = 'https://sandbox.safaricom.co.ke';

function eatTimestamp(now) {
  const values = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).filter(({ type }) => type !== 'literal').map(({ type, value }) => [type, value]));
  return `${values.year}${values.month}${values.day}${values.hour}${values.minute}${values.second}`;
}

async function responseJson(response, operation) {
  let body;
  try { body = await response.json(); } catch { throw new Error(`${operation} returned invalid JSON`); }
  if (!response.ok) {
    const error = new Error(`${operation} failed with HTTP ${response.status}`);
    error.code = 'DARAJA_REQUEST_FAILED';
    throw error;
  }
  return body;
}

export class DarajaSandboxClient {
  constructor({ consumerKey, consumerSecret, shortcode, passkey, callbackUrl, baseUrl = SANDBOX_BASE_URL, fetchImpl = fetch, now = () => new Date(), timeoutMs = 10_000 }) {
    Object.assign(this, { consumerKey, consumerSecret, shortcode, passkey, callbackUrl, baseUrl: baseUrl.replace(/\/$/, ''), fetchImpl, now, timeoutMs });
    this.accessToken = null;
    this.accessTokenExpiresAt = 0;
  }

  async initiateStkPush({ amountMinor, currency, phone, reference }) {
    if (currency !== 'KES' || !Number.isSafeInteger(amountMinor) || amountMinor <= 0 || amountMinor % 100 !== 0) {
      throw new Error('Daraja STK amount must be a positive whole KES amount');
    }
    const token = await this.#accessToken();
    const timestamp = eatTimestamp(this.now());
    const password = Buffer.from(`${this.shortcode}${this.passkey}${timestamp}`).toString('base64');
    const msisdn = phone.replace(/^\+/, '');
    const response = await this.#request(`${this.baseUrl}/mpesa/stkpush/v1/processrequest`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        BusinessShortCode: this.shortcode, Password: password, Timestamp: timestamp,
        TransactionType: 'CustomerPayBillOnline', Amount: amountMinor / 100,
        PartyA: msisdn, PartyB: this.shortcode, PhoneNumber: msisdn,
        CallBackURL: this.callbackUrl, AccountReference: reference, TransactionDesc: 'TillFlow sale',
      }),
    });
    const body = await responseJson(response, 'Daraja STK push');
    if (!body.CheckoutRequestID) {
      const error = new Error('Daraja STK push response did not include CheckoutRequestID');
      error.code = 'DARAJA_REQUEST_FAILED';
      throw error;
    }
    return { providerRequestId: body.CheckoutRequestID, status: 'pending' };
  }

  async #accessToken() {
    if (this.accessToken && this.now().getTime() < this.accessTokenExpiresAt) return this.accessToken;
    const basic = Buffer.from(`${this.consumerKey}:${this.consumerSecret}`).toString('base64');
    const response = await this.#request(`${this.baseUrl}/oauth/v1/generate?grant_type=client_credentials`, {
      headers: { Authorization: `Basic ${basic}` },
    });
    const body = await responseJson(response, 'Daraja OAuth');
    if (!body.access_token) throw new Error('Daraja OAuth response did not include an access token');
    const lifetimeMs = Math.max(60, Number(body.expires_in) || 300) * 1000;
    this.accessToken = body.access_token;
    // Refresh one minute before expiry so a request never starts with a token
    // that is about to expire at the provider.
    this.accessTokenExpiresAt = this.now().getTime() + Math.max(0, lifetimeMs - 60_000);
    return this.accessToken;
  }

  async #request(url, options) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(url, { ...options, signal: controller.signal });
    } catch (cause) {
      const error = new Error('Daraja request could not be confirmed');
      error.code = cause?.name === 'AbortError' ? 'DARAJA_TIMEOUT' : 'DARAJA_UNAVAILABLE';
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}
