import { createHmac, timingSafeEqual } from 'node:crypto';

const MAX_SKEW_MS = 5 * 60 * 1000;

// Internal service-to-service authentication: a caller (POS, Commission)
// proves both its identity and the tenant it is acting for by presenting a
// signed, time-bound token. A tenant ID appearing in a request body alone is
// never authorization — the signature is what the callee actually trusts.
// This is a shared-secret scheme (HMAC over "tenantId.timestamp"), not a
// general-purpose auth system: it assumes both sides hold the same secret,
// distributed out of band (Secrets Manager in deployed environments).

export function signServiceAuth(tenantId, secret, now = () => Date.now()) {
  const timestamp = String(now());
  const signature = createHmac('sha256', secret).update(`${tenantId}.${timestamp}`).digest('hex');
  return `${tenantId}.${timestamp}.${signature}`;
}

// Returns { tenantId } for a valid, fresh, correctly signed token, or null
// for anything else — malformed, expired/future-dated beyond the allowed
// skew, or a signature that does not verify. Callers must treat null as
// "unauthenticated," never fall back to trusting an unsigned tenant ID.
export function verifyServiceAuth(header, secret, now = () => Date.now()) {
  if (typeof header !== 'string') return null;
  const parts = header.split('.');
  if (parts.length !== 3) return null;
  const [tenantId, timestamp, signature] = parts;
  if (!tenantId || !/^\d+$/.test(timestamp) || !/^[0-9a-f]+$/i.test(signature)) return null;
  const age = now() - Number(timestamp);
  if (age < -MAX_SKEW_MS || age > MAX_SKEW_MS) return null;
  const expected = createHmac('sha256', secret).update(`${tenantId}.${timestamp}`).digest('hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  const actualBuf = Buffer.from(signature, 'hex');
  if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) return null;
  return { tenantId };
}
