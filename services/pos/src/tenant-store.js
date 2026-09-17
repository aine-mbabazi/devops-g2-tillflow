// Minimal "tenant setup": attendants and the commission rate an owner has
// configured for their till. Local persistence boundary, same caveat as the
// other in-memory stores: erased on restart, not yet production-durable.
export class InMemoryTenantStore {
  #byId = new Map();

  // Owner-driven configuration is a full replace, not a merge: the owner is
  // always describing the current desired state of their tenant.
  configure(tenantId, { attendants, commissionRateBasisPoints, tills = [], roles = {} }) {
    const config = { tenantId, attendants, commissionRateBasisPoints, tills, roles };
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
    // Emitted even when empty so a client can rely on the shape being stable
    // across versions: an older config saved before tills/roles existed reads
    // back as an empty list and an empty map, not as a missing key.
    tills: (config.tills ?? []).map((till) => ({
      till_id: till.id, name: till.name, attendant_ids: till.attendantIds,
    })),
    roles: config.roles ?? {},
  };
}
