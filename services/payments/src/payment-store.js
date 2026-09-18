import { randomUUID } from 'node:crypto';

// Local persistence boundary. It implements the future database uniqueness
// rules but is erased on restart, so it is not yet production-durable.
export class InMemoryPaymentStore {
  #byId = new Map();
  #byKey = new Map();
  #bySale = new Map();

  createOrGet(input) {
    const key = `${input.tenantId}\u0000${input.idempotencyKey}`;
    const existing = this.#byKey.get(key);
    if (existing) return existing.fingerprint === input.fingerprint
      ? { kind: 'existing', payment: existing } : { kind: 'idempotency_conflict' };
    const saleKey = `${input.tenantId}\u0000${input.saleId}`;
    const salePayment = this.#bySale.get(saleKey);
    if (salePayment && ['pending', 'succeeded'].includes(salePayment.status)) return { kind: 'sale_conflict' };
    // createdAt is what the callback-lag SLI measures from. The Postgres
    // store gets it from the column default; here it is stamped explicitly so
    // both stores expose the same field and app.js needs no branch.
    const payment = { ...input, id: `payment_${randomUUID()}`, status: 'pending', providerRequestId: null, createdAt: new Date() };
    this.#byId.set(payment.id, payment);
    this.#byKey.set(key, payment);
    this.#bySale.set(saleKey, payment);
    return { kind: 'created', payment };
  }

  // In-memory state has no dependency to reach, so readiness is process liveness.
  ping() {}

  findById(id) { return this.#byId.get(id) ?? null; }
  findByProviderRequestId(id) { return [...this.#byId.values()].find((payment) => payment.providerRequestId === id) ?? null; }

  transition(id, status) {
    const payment = this.#byId.get(id);
    if (!payment) return null;
    if (payment.status === 'pending') payment.status = status;
    return payment;
  }

  attachProviderRequest(id, providerRequestId) {
    const payment = this.#byId.get(id);
    if (!payment) throw new Error('Payment does not exist');
    payment.providerRequestId = providerRequestId;
  }
}

export function toPaymentResponse(payment) {
  return {
    payment_id: payment.id, tenant_id: payment.tenantId, sale_id: payment.saleId,
    amount_minor: payment.amountMinor, currency: payment.currency, status: payment.status,
  };
}
