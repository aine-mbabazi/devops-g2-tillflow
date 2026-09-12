CREATE SCHEMA IF NOT EXISTS payments;

CREATE TABLE IF NOT EXISTS payments.payment_attempts (
  payment_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  sale_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  currency CHAR(3) NOT NULL CHECK (currency = 'KES'),
  customer_phone TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed')),
  provider_request_id TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT payment_attempts_tenant_idempotency_unique UNIQUE (tenant_id, idempotency_key)
);

-- An active sale cannot be sent to the provider twice. Failed attempts remain
-- in the audit history and may be retried later with a fresh idempotency key.
CREATE UNIQUE INDEX IF NOT EXISTS payment_attempts_one_active_attempt_per_sale
  ON payments.payment_attempts (tenant_id, sale_id)
  WHERE status IN ('pending', 'succeeded');
