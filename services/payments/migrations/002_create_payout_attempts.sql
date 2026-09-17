CREATE TABLE IF NOT EXISTS payments.payout_attempts (
  payout_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  attendant_id TEXT NOT NULL,
  commission_run_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  currency CHAR(3) NOT NULL CHECK (currency = 'KES'),
  recipient_phone TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed')),
  provider_request_id TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT payout_attempts_tenant_idempotency_unique UNIQUE (tenant_id, idempotency_key)
);

-- One payout per attendant per commission run, by construction: a ledger item
-- cannot be sent to the provider twice. Failed attempts remain in the audit
-- history and may be retried later with a fresh idempotency key.
CREATE UNIQUE INDEX IF NOT EXISTS payout_attempts_one_active_attempt_per_ledger_item
  ON payments.payout_attempts (tenant_id, commission_run_id, attendant_id)
  WHERE status IN ('pending', 'succeeded');
