function entryFromRow(row) {
  return {
    tenantId: row.tenant_id, commissionRunId: row.commission_run_id, attendantId: row.attendant_id,
    idempotencyKey: row.idempotency_key, amountMinor: Number(row.amount_minor), payoutId: row.payout_id, status: row.status,
  };
}

export class PostgresCommissionLedger {
  constructor(pool) {
    if (!pool || typeof pool.query !== 'function') throw new Error('A PostgreSQL pool is required');
    this.pool = pool;
  }

  async get(tenantId, commissionRunId, attendantId) {
    const result = await this.pool.query(
      `SELECT tenant_id, commission_run_id, attendant_id, idempotency_key, amount_minor, payout_id, status
       FROM commission.ledger_entries WHERE tenant_id = $1 AND commission_run_id = $2 AND attendant_id = $3`,
      [tenantId, commissionRunId, attendantId],
    );
    return result.rows[0] ? entryFromRow(result.rows[0]) : null;
  }

  // Upsert: recording the same (tenant, run, attendant) again — e.g. after
  // ledger reconciliation updates its status — replaces the row in place.
  async record(entry) {
    await this.pool.query(
      `INSERT INTO commission.ledger_entries (tenant_id, commission_run_id, attendant_id, idempotency_key, amount_minor, payout_id, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (tenant_id, commission_run_id, attendant_id)
       DO UPDATE SET idempotency_key = $4, amount_minor = $5, payout_id = $6, status = $7, updated_at = now()`,
      [entry.tenantId, entry.commissionRunId, entry.attendantId, entry.idempotencyKey, entry.amountMinor, entry.payoutId, entry.status],
    );
  }

  async listPending() {
    const result = await this.pool.query(
      `SELECT tenant_id, commission_run_id, attendant_id, idempotency_key, amount_minor, payout_id, status
       FROM commission.ledger_entries WHERE status = 'pending'`,
    );
    return result.rows.map(entryFromRow);
  }
}
