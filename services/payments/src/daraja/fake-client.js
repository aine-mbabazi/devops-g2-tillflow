import { randomUUID } from 'node:crypto';

// Local test double, not a simulation of Daraja's wire protocol.
// Durable idempotency belongs in the future payment application/database layer.
export class FakeDarajaClient {
  #attempts = new Map();

  async initiateStkPush({ amountMinor, currency, phone }) {
    if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
      throw new Error('amountMinor must be a positive safe integer');
    }
    if (currency !== 'KES') throw new Error('Only KES is supported');
    if (typeof phone !== 'string' || !phone.trim()) {
      throw new Error('A synthetic test phone is required');
    }
    const providerRequestId = `fake-${randomUUID()}`;
    this.#attempts.set(providerRequestId, 'pending');
    return { providerRequestId, status: 'pending' };
  }

  async queryPayment(providerRequestId) {
    if (!this.#attempts.has(providerRequestId)) throw new Error('Unknown fake payment');
    return { providerRequestId, status: this.#attempts.get(providerRequestId) };
  }

  // Test-only control: initiation alone never implies a successful payment.
  simulateOutcome(providerRequestId, status) {
    if (!['succeeded', 'failed'].includes(status)) throw new Error('Invalid outcome');
    const current = this.#attempts.get(providerRequestId);
    if (!current) throw new Error('Unknown fake payment');
    if (current !== 'pending' && current !== status) {
      throw new Error('Cannot change a terminal outcome');
    }
    this.#attempts.set(providerRequestId, status);
  }
}
