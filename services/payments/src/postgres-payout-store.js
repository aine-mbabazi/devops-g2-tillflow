import { randomUUID } from 'node:crypto';

function payoutFromRow(row) {
  return {
    id: row.payout_id,
    tenantId: row.tenant_id,
    attendantId: row.attendant_id,
    commissionRunId: row.commission_run_id,
    idempotencyKey: row.idempotency_key,
    fingerprint: row.request_fingerprint,
    amountMinor: Number(row.amount_minor),
    currency: row.currency,
    recipientPhone: row.recipient_phone,
    status: row.status,
    providerRequestId: row.provider_request_id,
  };
}

const fields = `payout_id, tenant_id, attendant_id, commission_run_id, idempotency_key, request_fingerprint,
  amount_minor, currency, recipient_phone, status, provider_request_id`;

// The pool is injected to keep database access testable and avoid opening a
// connection at module load time. `pg.Pool` satisfies this interface.
export class PostgresPayoutStore {
  constructor(pool) {
    if (!pool || typeof pool.query !== 'function') throw new Error('A PostgreSQL pool is required');
    this.pool = pool;
  }

  async createOrGet(input) {
    const payoutId = `payout_${randomUUID()}`;
    try {
      const inserted = await this.pool.query(
        `INSERT INTO payments.payout_attempts (${fields})
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', NULL)
         ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
         RETURNING ${fields}`,
        [payoutId, input.tenantId, input.attendantId, input.commissionRunId, input.idempotencyKey, input.fingerprint,
          input.amountMinor, input.currency, input.recipientPhone],
      );
      if (inserted.rows[0]) return { kind: 'created', payout: payoutFromRow(inserted.rows[0]) };
    } catch (error) {
      if (error.code !== '23505') throw error;
      // The partial unique active-ledger-item index won the concurrent insert race.
      const existingLedgerItem = await this.#findActiveLedgerItem(input.tenantId, input.commissionRunId, input.attendantId);
      if (existingLedgerItem) return { kind: 'ledger_conflict' };
      throw error;
    }

    const existing = await this.#findByIdempotencyKey(input.tenantId, input.idempotencyKey);
    if (!existing) throw new Error('Idempotency conflict did not return an existing payout');
    return existing.fingerprint === input.fingerprint
      ? { kind: 'existing', payout: existing }
      : { kind: 'idempotency_conflict' };
  }

  async findById(payoutId) {
    const result = await this.pool.query(
      `SELECT ${fields} FROM payments.payout_attempts WHERE payout_id = $1`, [payoutId],
    );
    return result.rows[0] ? payoutFromRow(result.rows[0]) : null;
  }

  async attachProviderRequest(payoutId, providerRequestId) {
    const result = await this.pool.query(
      `UPDATE payments.payout_attempts
       SET provider_request_id = $2, updated_at = now()
       WHERE payout_id = $1
       RETURNING payout_id`,
      [payoutId, providerRequestId],
    );
    if (!result.rows[0]) throw new Error('Payout does not exist');
  }

  async findByProviderRequestId(providerRequestId) {
    const result = await this.pool.query(
      `SELECT ${fields} FROM payments.payout_attempts WHERE provider_request_id = $1`, [providerRequestId],
    );
    return result.rows[0] ? payoutFromRow(result.rows[0]) : null;
  }

  async transition(payoutId, status) {
    const result = await this.pool.query(
      `UPDATE payments.payout_attempts SET status = CASE WHEN status = 'pending' THEN $2 ELSE status END, updated_at = now()
       WHERE payout_id = $1 RETURNING ${fields}`,
      [payoutId, status],
    );
    return result.rows[0] ? payoutFromRow(result.rows[0]) : null;
  }

  async #findByIdempotencyKey(tenantId, idempotencyKey) {
    const result = await this.pool.query(
      `SELECT ${fields} FROM payments.payout_attempts
       WHERE tenant_id = $1 AND idempotency_key = $2`, [tenantId, idempotencyKey],
    );
    return result.rows[0] ? payoutFromRow(result.rows[0]) : null;
  }

  async #findActiveLedgerItem(tenantId, commissionRunId, attendantId) {
    const result = await this.pool.query(
      `SELECT payout_id FROM payments.payout_attempts
       WHERE tenant_id = $1 AND commission_run_id = $2 AND attendant_id = $3 AND status IN ('pending', 'succeeded')`,
      [tenantId, commissionRunId, attendantId],
    );
    return result.rows[0] ?? null;
  }
}
