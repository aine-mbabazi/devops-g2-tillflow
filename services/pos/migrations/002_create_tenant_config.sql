CREATE TABLE IF NOT EXISTS pos.tenant_config (
  tenant_id TEXT PRIMARY KEY,
  -- [{ "id": "attendant_...", "phone": "+254..." }, ...]
  attendants JSONB NOT NULL,
  commission_rate_basis_points INTEGER NOT NULL CHECK (commission_rate_basis_points BETWEEN 0 AND 10000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
