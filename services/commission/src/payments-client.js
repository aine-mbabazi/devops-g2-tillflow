import { signServiceAuth } from '../../_shared/service-auth.js';

// The only way Commission reaches Daraja: through the Payments API. This
// client has no knowledge of Daraja, M-Pesa, or provider credentials at all —
// "Commission must never call Daraja directly" is enforced structurally by
// this file being the sole network boundary and never importing a Daraja client.
export class PaymentsClient {
  constructor({ baseUrl, serviceAuthSecret, fetchImpl = fetch }) {
    if (!serviceAuthSecret) throw new Error('A service auth secret is required');
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.serviceAuthSecret = serviceAuthSecret;
    this.fetchImpl = fetchImpl;
  }

  async requestPayout({ idempotencyKey, tenantId, attendantId, commissionRunId, amountMinor, currency, recipientPhone }) {
    const response = await this.fetchImpl(`${this.baseUrl}/payouts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey, 'x-service-auth': signServiceAuth(tenantId, this.serviceAuthSecret) },
      body: JSON.stringify({
        tenant_id: tenantId, attendant_id: attendantId, commission_run_id: commissionRunId,
        amount_minor: amountMinor, currency, recipient_phone: recipientPhone,
      }),
    });
    const body = await response.json();
    if (!response.ok) {
      const error = new Error(body.error ?? `payout request failed with HTTP ${response.status}`);
      error.status = response.status;
      error.body = body;
      throw error;
    }
    return body;
  }

  async getPayout(tenantId, payoutId) {
    const response = await this.fetchImpl(`${this.baseUrl}/payouts/${encodeURIComponent(payoutId)}`, {
      headers: { 'x-service-auth': signServiceAuth(tenantId, this.serviceAuthSecret) },
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`getPayout failed with HTTP ${response.status}`);
    return response.json();
  }
}
