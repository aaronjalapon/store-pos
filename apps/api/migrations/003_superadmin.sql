ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_superadmin boolean NOT NULL DEFAULT false;

ALTER TABLE store_memberships
  DROP CONSTRAINT IF EXISTS store_memberships_role_check;

ALTER TABLE store_memberships
  ADD CONSTRAINT store_memberships_role_check CHECK (role IN ('owner', 'admin', 'cashier'));
