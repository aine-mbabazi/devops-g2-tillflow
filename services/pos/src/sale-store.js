import { randomUUID } from 'node:crypto';

// Local persistence boundary, same caveat as the Payments in-memory stores:
// implements the future database uniqueness rules but is erased on restart.
export class InMemorySaleStore {
  #byId = new Map();
  #byKey = new Map();

  createOrGet(input) {
    const key = `${input.tenantId}${input.idempotencyKey}`;
    const existing = this.#byKey.get(key);
    if (existing) return existing.fingerprint === input.fingerprint
      ? { kind: 'existing', sale: existing } : { kind: 'idempotency_conflict' };
    const sale = { ...input, id: `sale_${randomUUID()}`, status: 'unpaid', paymentId: null, commissionRunId: null };
    this.#byId.set(sale.id, sale);
    this.#byKey.set(key, sale);
    return { kind: 'created', sale };
  }

  findById(id) { return this.#byId.get(id) ?? null; }

  // Readiness probe: the in-memory store has no external dependency, so it
  // is always considered reachable. Mirrors PostgresSaleStore.ping so the
  // /ready handler can call one method on either store.
  ping() { return Promise.resolve(); }

  // A sale claimed by a different commission run must never resurface -
  // otherwise the same sale gets commission calculated on it twice. A sale
  // already claimed by *this* run stays visible, so a rerun of the same run
  // (retry, restart) still sees it and can safely re-request the same payout.
  listPaid(tenantId, commissionRunId) {
    return [...this.#byId.values()].filter((sale) => sale.tenantId === tenantId && sale.status === 'paid'
      && (sale.commissionRunId === null || sale.commissionRunId === commissionRunId));
  }

  // Idempotent: claiming a sale already claimed by this same run is a no-op.
  // Claiming is silently skipped for a sale already claimed by a *different*
  // run or one this tenant doesn't own - that should never happen if the
  // caller only claims IDs it just read from listPaid, but it must never
  // let one tenant's close claim another tenant's sale.
  claimForCommissionRun(tenantId, commissionRunId, saleIds) {
    for (const saleId of saleIds) {
      const sale = this.#byId.get(saleId);
      if (!sale || sale.tenantId !== tenantId) continue;
      if (sale.commissionRunId === null) sale.commissionRunId = commissionRunId;
    }
  }

  attachPaymentId(id, paymentId) {
    const sale = this.#byId.get(id);
    if (!sale) throw new Error('Sale does not exist');
    sale.paymentId = paymentId;
  }

  // Idempotent: marking an already-paid sale paid again is a no-op, matching
  // the contract's "applying that result must be idempotent."
  markPaid(id) {
    const sale = this.#byId.get(id);
    if (!sale) return null;
    if (sale.status === 'unpaid') sale.status = 'paid';
    return sale;
  }
}

export function toSaleResponse(sale) {
  return {
    sale_id: sale.id, tenant_id: sale.tenantId, attendant_id: sale.attendantId, line_items: sale.lineItems,
    amount_minor: sale.amountMinor, currency: sale.currency, status: sale.status, payment_id: sale.paymentId,
  };
}
