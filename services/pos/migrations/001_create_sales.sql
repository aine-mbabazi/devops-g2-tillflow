CREATE SCHEMA IF NOT EXISTS pos;

CREATE TABLE IF NOT EXISTS pos.sales (
  sale_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  attendant_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  line_items JSONB NOT NULL,
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  currency CHAR(3) NOT NULL CHECK (currency = 'KES'),
  customer_phone TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('unpaid', 'paid')),
  payment_id TEXT,
  -- NULL until a commission run claims this sale; once claimed, excluded
  -- from every other run's paid-sales listing so it can never be paid
  -- commission on twice.
  commission_run_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sales_tenant_idempotency_unique UNIQUE (tenant_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS sales_tenant_paid_unclaimed
  ON pos.sales (tenant_id, commission_run_id)
  WHERE status = 'paid';
