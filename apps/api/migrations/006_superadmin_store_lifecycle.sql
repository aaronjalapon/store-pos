ALTER TABLE stores
  ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;

CREATE INDEX IF NOT EXISTS stores_active_idx ON stores(is_active);
