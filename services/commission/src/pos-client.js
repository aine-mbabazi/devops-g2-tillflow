import { signServiceAuth } from '../../_shared/service-auth.js';

// Commission's read-only view of POS: confirmed paid sales and the tenant's
// configured attendants/commission rate. Like PaymentsClient, this is the
// only network boundary for reaching POS — no other file talks to it.
export class PosClient {
  constructor({ baseUrl, serviceAuthSecret, fetchImpl = fetch }) {
    if (!serviceAuthSecret) throw new Error('A service auth secret is required');
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.serviceAuthSecret = serviceAuthSecret;
    this.fetchImpl = fetchImpl;
  }

  // Scoped to commissionRunId: POS excludes any sale already claimed by a
  // *different* run, so a sale already paid out by a previous day's close
  // never gets recalculated into this one.
  async listPaidSales(tenantId, commissionRunId) {
    const response = await this.fetchImpl(`${this.baseUrl}/sales?status=paid&commission_run_id=${encodeURIComponent(commissionRunId)}`, {
      headers: { 'x-service-auth': signServiceAuth(tenantId, this.serviceAuthSecret) },
    });
    if (!response.ok) throw new Error(`listPaidSales failed with HTTP ${response.status}`);
    const { sales } = await response.json();
    return sales.map((sale) => ({
      saleId: sale.sale_id, tenantId: sale.tenant_id, attendantId: sale.attendant_id, amountMinor: sale.amount_minor, status: sale.status,
    }));
  }

  // Marks sales as belonging to this commission run so they're excluded from
  // every future run's listPaidSales — this is what actually prevents the
  // same sale being paid commission on twice.
  async claimSales(tenantId, commissionRunId, saleIds) {
    if (saleIds.length === 0) return;
    const response = await this.fetchImpl(`${this.baseUrl}/sales/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-service-auth': signServiceAuth(tenantId, this.serviceAuthSecret) },
      body: JSON.stringify({ commission_run_id: commissionRunId, sale_ids: saleIds }),
    });
    if (!response.ok) throw new Error(`claimSales failed with HTTP ${response.status}`);
  }

  async getTenantConfig(tenantId) {
    const response = await this.fetchImpl(`${this.baseUrl}/tenants/${encodeURIComponent(tenantId)}/config`, {
      headers: { 'x-service-auth': signServiceAuth(tenantId, this.serviceAuthSecret) },
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`getTenantConfig failed with HTTP ${response.status}`);
    const body = await response.json();
    return {
      attendantPhones: Object.fromEntries(body.attendants.map((attendant) => [attendant.attendant_id, attendant.phone])),
      commissionRateBasisPoints: body.commission_rate_basis_points,
    };
  }
}
