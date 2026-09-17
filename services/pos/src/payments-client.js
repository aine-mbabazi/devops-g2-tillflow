import { signServiceAuth } from '../../_shared/service-auth.js';

// The only way POS reaches Daraja: through the Payments API. This client has
// no knowledge of Daraja, M-Pesa, or provider credentials — POS never talks
// to Daraja directly, matching the same boundary Commission's client enforces.
export class PaymentsClient {
  constructor({ baseUrl, serviceAuthSecret, fetchImpl = fetch }) {
    if (!serviceAuthSecret) throw new Error('A service auth secret is required');
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.serviceAuthSecret = serviceAuthSecret;
    this.fetchImpl = fetchImpl;
  }

  async requestPayment({ idempotencyKey, tenantId, saleId, amountMinor, currency, customerPhone }) {
    const response = await this.fetchImpl(`${this.baseUrl}/payments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey, 'x-service-auth': signServiceAuth(tenantId, this.serviceAuthSecret) },
      body: JSON.stringify({ tenant_id: tenantId, sale_id: saleId, amount_minor: amountMinor, currency, customer_phone: customerPhone }),
    });
    const body = await response.json();
    if (!response.ok) {
      const error = new Error(body.error ?? `payment request failed with HTTP ${response.status}`);
      error.status = response.status;
      error.body = body;
      throw error;
    }
    return body;
  }

  async getPayment(tenantId, paymentId) {
    const response = await this.fetchImpl(`${this.baseUrl}/payments/${encodeURIComponent(paymentId)}`, {
      headers: { 'x-service-auth': signServiceAuth(tenantId, this.serviceAuthSecret) },
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`getPayment failed with HTTP ${response.status}`);
    return response.json();
  }
}
