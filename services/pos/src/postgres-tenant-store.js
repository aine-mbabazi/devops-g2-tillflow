function configFromRow(row) {
  return { tenantId: row.tenant_id, attendants: row.attendants, commissionRateBasisPoints: row.commission_rate_basis_points };
}

export class PostgresTenantStore {
  constructor(pool) {
    if (!pool || typeof pool.query !== 'function') throw new Error('A PostgreSQL pool is required');
    this.pool = pool;
  }

  // Full replace, matching InMemoryTenantStore: an owner is always
  // describing the current desired state of their till, not merging in a diff.
  async configure(tenantId, { attendants, commissionRateBasisPoints }) {
    const result = await this.pool.query(
      `INSERT INTO pos.tenant_config (tenant_id, attendants, commission_rate_basis_points)
       VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id) DO UPDATE SET attendants = $2, commission_rate_basis_points = $3, updated_at = now()
       RETURNING tenant_id, attendants, commission_rate_basis_points`,
      [tenantId, JSON.stringify(attendants), commissionRateBasisPoints],
    );
    return configFromRow(result.rows[0]);
  }

  async get(tenantId) {
    const result = await this.pool.query(
      `SELECT tenant_id, attendants, commission_rate_basis_points FROM pos.tenant_config WHERE tenant_id = $1`,
      [tenantId],
    );
    return result.rows[0] ? configFromRow(result.rows[0]) : null;
  }

  async hasAttendant(tenantId, attendantId) {
    const config = await this.get(tenantId);
    return config ? config.attendants.some((attendant) => attendant.id === attendantId) : false;
  }
}
