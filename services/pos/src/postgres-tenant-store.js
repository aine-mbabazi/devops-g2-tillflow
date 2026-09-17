function configFromRow(row) {
  return {
    tenantId: row.tenant_id,
    attendants: row.attendants,
    commissionRateBasisPoints: row.commission_rate_basis_points,
    tills: row.tills ?? [],
    roles: row.roles ?? {},
  };
}

export class PostgresTenantStore {
  constructor(pool) {
    if (!pool || typeof pool.query !== 'function') throw new Error('A PostgreSQL pool is required');
    this.pool = pool;
  }

  // Full replace, matching InMemoryTenantStore: an owner is always
  // describing the current desired state of their till, not merging in a diff.
  async configure(tenantId, { attendants, commissionRateBasisPoints, tills = [], roles = {} }) {
    const result = await this.pool.query(
      `INSERT INTO pos.tenant_config (tenant_id, attendants, commission_rate_basis_points, tills, roles)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id) DO UPDATE SET
         attendants = $2, commission_rate_basis_points = $3, tills = $4, roles = $5, updated_at = now()
       RETURNING tenant_id, attendants, commission_rate_basis_points, tills, roles`,
      [tenantId, JSON.stringify(attendants), commissionRateBasisPoints, JSON.stringify(tills), JSON.stringify(roles)],
    );
    return configFromRow(result.rows[0]);
  }

  async get(tenantId) {
    const result = await this.pool.query(
      `SELECT tenant_id, attendants, commission_rate_basis_points, tills, roles
         FROM pos.tenant_config WHERE tenant_id = $1`,
      [tenantId],
    );
    return result.rows[0] ? configFromRow(result.rows[0]) : null;
  }

  async hasAttendant(tenantId, attendantId) {
    const config = await this.get(tenantId);
    return config ? config.attendants.some((attendant) => attendant.id === attendantId) : false;
  }
}
