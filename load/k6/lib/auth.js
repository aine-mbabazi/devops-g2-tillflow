import crypto from 'k6/crypto';

// Mirrors services/_shared/service-auth.js. k6 cannot import the service's
// own module (it is Node ESM using node:crypto), so the scheme is
// reimplemented here against k6/crypto. If the shared module's token format
// changes, this must change with it — services/pos/test/pos.test.js is the
// contract that would catch a drift on the service side, and the smoke test
// below is what catches it here.
export function signServiceAuth(tenantId, secret) {
  const timestamp = String(Date.now());
  const signature = crypto.hmac('sha256', secret, `${tenantId}.${timestamp}`, 'hex');
  return `${tenantId}.${timestamp}.${signature}`;
}
