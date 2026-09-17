import { calculateCommissions } from './calculate.js';

// A rerun of the same (tenantId, commissionRunId) must not double-pay. The
// idempotency key is derived deterministically from the ledger item itself
// (not a random value), so re-running this exact close reuses the same key
// on every attempt — Payments' own idempotency and ledger-item uniqueness
// are what actually prevent a duplicate payout; this worker never needs a
// separate "have I already done this" check to stay safe, only to stay quiet.
function idempotencyKeyFor({ commissionRunId, attendantId }) {
  return `close:${commissionRunId}:${attendantId}`;
}

export async function runDailyClose({
  tenantId, commissionRunId, currency = 'KES', posClient, paymentsClient, ledger, log = () => {},
}) {
  const config = await posClient.getTenantConfig(tenantId);
  if (!config) {
    log({ event: 'daily_close_skipped_unconfigured_tenant', tenantId, commissionRunId });
    return [];
  }
  const paidSales = await posClient.listPaidSales(tenantId, commissionRunId);
  const commissions = calculateCommissions({
    paidSales: paidSales.filter((sale) => sale.tenantId === tenantId),
    commissionRateBasisPoints: config.commissionRateBasisPoints,
  });

  const results = [];
  for (const { attendantId, amountMinor, saleIds } of commissions) {
    const recipientPhone = config.attendantPhones[attendantId];
    if (!recipientPhone) {
      // Left unclaimed on purpose: once the attendant's phone is configured,
      // a later run must still be able to pay out for these same sales.
      log({ event: 'payout_skipped_missing_phone', tenantId, commissionRunId, attendantId });
      continue;
    }
    const idempotencyKey = idempotencyKeyFor({ commissionRunId, attendantId });
    try {
      const payout = await paymentsClient.requestPayout({
        idempotencyKey, tenantId, attendantId, commissionRunId, amountMinor, currency, recipientPhone,
      });
      // Only claim once Payments has durably accepted the request — a
      // failed request below leaves these sales unclaimed so a retry (even
      // under a different run ID) still finds and pays them.
      await posClient.claimSales(tenantId, commissionRunId, saleIds);
      await ledger.record({ tenantId, commissionRunId, attendantId, idempotencyKey, amountMinor, payoutId: payout.payout_id, status: payout.status });
      results.push({ tenantId, attendantId, amountMinor, payoutId: payout.payout_id, status: payout.status });
    } catch (error) {
      log({ event: 'payout_request_failed', tenantId, commissionRunId, attendantId, message: error.message });
      results.push({ tenantId, attendantId, amountMinor, status: 'request_failed', error: error.message });
    }
  }
  return results;
}

// The ledger's payout status is written once, when the payout is first
// requested — almost always still 'pending' (B2C is asynchronous). Nothing
// updates it after that unless something calls back here: this walks every
// pending ledger entry, asks Payments for its current status, and rewrites
// the entry so the ledger eventually reflects the real terminal outcome.
export async function reconcilePendingLedgerEntries({ ledger, paymentsClient, log = () => {} }) {
  const updated = [];
  for (const entry of await ledger.listPending()) {
    const payout = await paymentsClient.getPayout(entry.tenantId, entry.payoutId);
    if (!payout || payout.status === 'pending') continue;
    await ledger.record({ ...entry, status: payout.status });
    log({ event: 'ledger_entry_reconciled', tenantId: entry.tenantId, commissionRunId: entry.commissionRunId, attendantId: entry.attendantId, status: payout.status });
    updated.push({ ...entry, status: payout.status });
  }
  return updated;
}
