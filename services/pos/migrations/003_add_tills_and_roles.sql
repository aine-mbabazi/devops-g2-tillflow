-- Adds till configuration and tenant-scoped roles to the existing tenant
-- config row. Both columns default to an empty value so a row written before
-- this migration reads back as "no tills, no roles" rather than NULL, which
-- the stores already normalise but the column should not rely on.
ALTER TABLE pos.tenant_config
  ADD COLUMN IF NOT EXISTS tills JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS roles JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN pos.tenant_config.tills IS
  '[{ "id": "till_...", "name": "...", "attendantIds": ["attendant_..."] }, ...]';
COMMENT ON COLUMN pos.tenant_config.roles IS
  '{ "role_name": ["permission", ...], ... }';
