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
  tenantId, commissionRunId, paidSales, commissionRateBasisPoints, attendantPhones,
  currency = 'KES', paymentsClient, ledger, log = () => {},
}) {
  const commissions = calculateCommissions({
    paidSales: paidSales.filter((sale) => sale.tenantId === tenantId),
    commissionRateBasisPoints,
  });

  const results = [];
  for (const { attendantId, amountMinor } of commissions) {
    const recipientPhone = attendantPhones[attendantId];
    if (!recipientPhone) {
      log({ event: 'payout_skipped_missing_phone', tenantId, commissionRunId, attendantId });
      continue;
    }
    const idempotencyKey = idempotencyKeyFor({ commissionRunId, attendantId });
    try {
      const payout = await paymentsClient.requestPayout({
        idempotencyKey, tenantId, attendantId, commissionRunId, amountMinor, currency, recipientPhone,
      });
      ledger.record({ tenantId, commissionRunId, attendantId, idempotencyKey, amountMinor, payoutId: payout.payout_id, status: payout.status });
      results.push({ tenantId, attendantId, amountMinor, payoutId: payout.payout_id, status: payout.status });
    } catch (error) {
      log({ event: 'payout_request_failed', tenantId, commissionRunId, attendantId, message: error.message });
      results.push({ tenantId, attendantId, amountMinor, status: 'request_failed', error: error.message });
    }
  }
  return results;
}
