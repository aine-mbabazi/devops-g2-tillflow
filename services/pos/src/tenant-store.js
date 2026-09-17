// Minimal "tenant setup": attendants and the commission rate an owner has
// configured for their till. Local persistence boundary, same caveat as the
// other in-memory stores: erased on restart, not yet production-durable.
export class InMemoryTenantStore {
  #byId = new Map();

  // Owner-driven configuration is a full replace, not a merge: the owner is
  // always describing the current desired state of their till.
  configure(tenantId, { attendants, commissionRateBasisPoints }) {
    const config = { tenantId, attendants, commissionRateBasisPoints };
    this.#byId.set(tenantId, config);
    return config;
  }

  get(tenantId) { return this.#byId.get(tenantId) ?? null; }

  hasAttendant(tenantId, attendantId) {
    const config = this.#byId.get(tenantId);
    return config ? config.attendants.some((attendant) => attendant.id === attendantId) : false;
  }
}

export function toTenantConfigResponse(config) {
  return {
    tenant_id: config.tenantId,
    attendants: config.attendants.map((attendant) => ({ attendant_id: attendant.id, phone: attendant.phone })),
    commission_rate_basis_points: config.commissionRateBasisPoints,
  };
}
