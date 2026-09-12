import { randomUUID } from 'node:crypto';

function paymentFromRow(row) {
  return {
    id: row.payment_id,
    tenantId: row.tenant_id,
    saleId: row.sale_id,
    idempotencyKey: row.idempotency_key,
    fingerprint: row.request_fingerprint,
    amountMinor: Number(row.amount_minor),
    currency: row.currency,
    customerPhone: row.customer_phone,
    status: row.status,
    providerRequestId: row.provider_request_id,
  };
}

const fields = `payment_id, tenant_id, sale_id, idempotency_key, request_fingerprint,
  amount_minor, currency, customer_phone, status, provider_request_id`;

// The pool is injected to keep database access testable and avoid opening a
// connection at module load time. `pg.Pool` satisfies this interface.
export class PostgresPaymentStore {
  constructor(pool) {
    if (!pool || typeof pool.query !== 'function') throw new Error('A PostgreSQL pool is required');
    this.pool = pool;
  }

  async createOrGet(input) {
    const paymentId = `payment_${randomUUID()}`;
    try {
      const inserted = await this.pool.query(
        `INSERT INTO payments.payment_attempts (${fields})
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', NULL)
         ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
         RETURNING ${fields}`,
        [paymentId, input.tenantId, input.saleId, input.idempotencyKey, input.fingerprint,
          input.amountMinor, input.currency, input.customerPhone],
      );
      if (inserted.rows[0]) return { kind: 'created', payment: paymentFromRow(inserted.rows[0]) };
    } catch (error) {
      if (error.code !== '23505') throw error;
      // The partial unique active-sale index won the concurrent insert race.
      const existingSale = await this.#findActiveSale(input.tenantId, input.saleId);
      if (existingSale) return { kind: 'sale_conflict' };
      throw error;
    }

    const existing = await this.#findByIdempotencyKey(input.tenantId, input.idempotencyKey);
    if (!existing) throw new Error('Idempotency conflict did not return an existing payment');
    return existing.fingerprint === input.fingerprint
      ? { kind: 'existing', payment: existing }
      : { kind: 'idempotency_conflict' };
  }

  async findById(paymentId) {
    const result = await this.pool.query(
      `SELECT ${fields} FROM payments.payment_attempts WHERE payment_id = $1`, [paymentId],
    );
    return result.rows[0] ? paymentFromRow(result.rows[0]) : null;
  }

  async attachProviderRequest(paymentId, providerRequestId) {
    const result = await this.pool.query(
      `UPDATE payments.payment_attempts
       SET provider_request_id = $2, updated_at = now()
       WHERE payment_id = $1
       RETURNING payment_id`,
      [paymentId, providerRequestId],
    );
    if (!result.rows[0]) throw new Error('Payment does not exist');
  }

  async #findByIdempotencyKey(tenantId, idempotencyKey) {
    const result = await this.pool.query(
      `SELECT ${fields} FROM payments.payment_attempts
       WHERE tenant_id = $1 AND idempotency_key = $2`, [tenantId, idempotencyKey],
    );
    return result.rows[0] ? paymentFromRow(result.rows[0]) : null;
  }

  async #findActiveSale(tenantId, saleId) {
    const result = await this.pool.query(
      `SELECT payment_id FROM payments.payment_attempts
       WHERE tenant_id = $1 AND sale_id = $2 AND status IN ('pending', 'succeeded')`, [tenantId, saleId],
    );
    return result.rows[0] ?? null;
  }
}
