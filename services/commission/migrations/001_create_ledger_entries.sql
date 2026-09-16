CREATE SCHEMA IF NOT EXISTS commission;

CREATE TABLE IF NOT EXISTS commission.ledger_entries (
  tenant_id TEXT NOT NULL,
  commission_run_id TEXT NOT NULL,
  attendant_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  payout_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, commission_run_id, attendant_id)
);

CREATE INDEX IF NOT EXISTS ledger_entries_pending ON commission.ledger_entries (status) WHERE status = 'pending';
