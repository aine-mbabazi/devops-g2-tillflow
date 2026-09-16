import { randomUUID } from 'node:crypto';

function saleFromRow(row) {
  return {
    id: row.sale_id,
    tenantId: row.tenant_id,
    attendantId: row.attendant_id,
    idempotencyKey: row.idempotency_key,
    fingerprint: row.request_fingerprint,
    lineItems: row.line_items,
    amountMinor: Number(row.amount_minor),
    currency: row.currency,
    customerPhone: row.customer_phone,
    status: row.status,
    paymentId: row.payment_id,
    commissionRunId: row.commission_run_id,
  };
}

const fields = `sale_id, tenant_id, attendant_id, idempotency_key, request_fingerprint,
  line_items, amount_minor, currency, customer_phone, status, payment_id, commission_run_id`;

// The pool is injected to keep database access testable and avoid opening a
// connection at module load time, matching the Payments Postgres stores.
export class PostgresSaleStore {
  constructor(pool) {
    if (!pool || typeof pool.query !== 'function') throw new Error('A PostgreSQL pool is required');
    this.pool = pool;
  }

  async createOrGet(input) {
    const saleId = `sale_${randomUUID()}`;
    try {
      const inserted = await this.pool.query(
        `INSERT INTO pos.sales (${fields})
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'unpaid', NULL, NULL)
         ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
         RETURNING ${fields}`,
        [saleId, input.tenantId, input.attendantId, input.idempotencyKey, input.fingerprint,
          JSON.stringify(input.lineItems), input.amountMinor, input.currency, input.customerPhone],
      );
      if (inserted.rows[0]) return { kind: 'created', sale: saleFromRow(inserted.rows[0]) };
    } catch (error) {
      if (error.code !== '23505') throw error;
    }
    const existing = await this.#findByIdempotencyKey(input.tenantId, input.idempotencyKey);
    if (!existing) throw new Error('Idempotency conflict did not return an existing sale');
    return existing.fingerprint === input.fingerprint
      ? { kind: 'existing', sale: existing }
      : { kind: 'idempotency_conflict' };
  }

  async findById(saleId) {
    const result = await this.pool.query(`SELECT ${fields} FROM pos.sales WHERE sale_id = $1`, [saleId]);
    return result.rows[0] ? saleFromRow(result.rows[0]) : null;
  }

  // See InMemorySaleStore.listPaid for why a sale claimed by this same run
  // must stay visible while one claimed by any other run must not.
  async listPaid(tenantId, commissionRunId) {
    const result = await this.pool.query(
      `SELECT ${fields} FROM pos.sales
       WHERE tenant_id = $1 AND status = 'paid' AND (commission_run_id IS NULL OR commission_run_id = $2)`,
      [tenantId, commissionRunId],
    );
    return result.rows.map(saleFromRow);
  }

  async claimForCommissionRun(tenantId, commissionRunId, saleIds) {
    if (saleIds.length === 0) return;
    await this.pool.query(
      `UPDATE pos.sales SET commission_run_id = $2, updated_at = now()
       WHERE tenant_id = $1 AND sale_id = ANY($3::text[]) AND commission_run_id IS NULL`,
      [tenantId, commissionRunId, saleIds],
    );
  }

  async attachPaymentId(saleId, paymentId) {
    const result = await this.pool.query(
      `UPDATE pos.sales SET payment_id = $2, updated_at = now() WHERE sale_id = $1 RETURNING sale_id`,
      [saleId, paymentId],
    );
    if (!result.rows[0]) throw new Error('Sale does not exist');
  }

  async markPaid(saleId) {
    const result = await this.pool.query(
      `UPDATE pos.sales SET status = CASE WHEN status = 'unpaid' THEN 'paid' ELSE status END, updated_at = now()
       WHERE sale_id = $1 RETURNING ${fields}`,
      [saleId],
    );
    return result.rows[0] ? saleFromRow(result.rows[0]) : null;
  }

  async #findByIdempotencyKey(tenantId, idempotencyKey) {
    const result = await this.pool.query(
      `SELECT ${fields} FROM pos.sales WHERE tenant_id = $1 AND idempotency_key = $2`,
      [tenantId, idempotencyKey],
    );
    return result.rows[0] ? saleFromRow(result.rows[0]) : null;
  }
}
