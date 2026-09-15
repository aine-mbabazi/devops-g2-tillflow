import { randomUUID } from 'node:crypto';

// Local test double, not a simulation of Daraja's wire protocol.
// Durable idempotency belongs in the future payment application/database layer.
export class FakeDarajaClient {
  #attempts = new Map();

  async initiateStkPush({ amountMinor, currency, phone }) {
    return this.#initiate('fake', amountMinor, currency, phone);
  }

  async initiateB2C({ amountMinor, currency, phone }) {
    return this.#initiate('fake-b2c', amountMinor, currency, phone);
  }

  #initiate(prefix, amountMinor, currency, phone) {
    if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
      throw new Error('amountMinor must be a positive safe integer');
    }
    if (currency !== 'KES') throw new Error('Only KES is supported');
    if (typeof phone !== 'string' || !phone.trim()) {
      throw new Error('A synthetic test phone is required');
    }
    const providerRequestId = `${prefix}-${randomUUID()}`;
    this.#attempts.set(providerRequestId, 'pending');
    return { providerRequestId, status: 'pending' };
  }

  async queryPayment(providerRequestId) {
    if (!this.#attempts.has(providerRequestId)) throw new Error('Unknown fake payment');
    return { providerRequestId, status: this.#attempts.get(providerRequestId) };
  }

  // B2C reconciliation uses the same query semantics as STK reconciliation;
  // both ultimately ask "what is the provider's definitive outcome for this ID?"
  async queryB2C(providerRequestId) {
    return this.queryPayment(providerRequestId);
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
