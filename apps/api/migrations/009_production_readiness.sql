ALTER TABLE users
  ADD COLUMN IF NOT EXISTS credential_version integer NOT NULL DEFAULT 1
    CHECK (credential_version > 0);

ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS is_enrolled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS revoked_at timestamptz,
  ADD COLUMN IF NOT EXISTS revoked_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE stores
  ADD COLUMN IF NOT EXISTS maintenance_mode boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS auth_sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  store_id uuid REFERENCES stores(id) ON DELETE CASCADE,
  device_id uuid REFERENCES devices(id) ON DELETE CASCADE,
  credential_version integer NOT NULL CHECK (credential_version > 0),
  refresh_token_hash char(64) NOT NULL UNIQUE,
  refresh_expires_at timestamptz NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoke_reason varchar(80),
  CHECK ((store_id IS NULL AND device_id IS NULL) OR (store_id IS NOT NULL AND device_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS auth_sessions_user_active_idx
  ON auth_sessions(user_id, revoked_at, refresh_expires_at DESC);
CREATE INDEX IF NOT EXISTS auth_sessions_store_device_active_idx
  ON auth_sessions(store_id, device_id, revoked_at, refresh_expires_at DESC)
  WHERE store_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS device_enrollment_challenges (
  id uuid PRIMARY KEY,
  store_id uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id uuid NOT NULL,
  device_name varchar(80) NOT NULL,
  expires_at timestamptz NOT NULL,
  approved_at timestamptz,
  denied_at timestamptz,
  decided_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT (approved_at IS NOT NULL AND denied_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS device_enrollment_challenges_pending_idx
  ON device_enrollment_challenges(store_id, expires_at DESC)
  WHERE approved_at IS NULL AND denied_at IS NULL;

CREATE TABLE IF NOT EXISTS auth_rate_limits (
  key_hash char(64) PRIMARY KEY,
  action varchar(40) NOT NULL,
  window_started_at timestamptz NOT NULL,
  attempt_count integer NOT NULL CHECK (attempt_count > 0),
  blocked_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_rate_limits_updated_idx ON auth_rate_limits(updated_at);

ALTER TABLE backups
  ADD COLUMN IF NOT EXISTS format_version integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS encryption_key_id varchar(80),
  ADD COLUMN IF NOT EXISTS status varchar(24) NOT NULL DEFAULT 'legacy_plaintext',
  ADD COLUMN IF NOT EXISTS restored_at timestamptz,
  ADD COLUMN IF NOT EXISTS restore_verified_at timestamptz;
ALTER TABLE backups DROP CONSTRAINT IF EXISTS backups_status_check;
ALTER TABLE backups ADD CONSTRAINT backups_status_check
  CHECK (status IN ('staging', 'complete', 'failed', 'expired', 'legacy_plaintext'));

CREATE TABLE IF NOT EXISTS object_operations (
  id uuid PRIMARY KEY,
  store_id uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  operation varchar(24) NOT NULL CHECK (operation IN ('finalize', 'delete')),
  object_kind varchar(32) NOT NULL CHECK (object_kind IN ('product_image', 'qrph_image', 'backup')),
  staging_key text,
  final_key text NOT NULL,
  content_type varchar(80),
  status varchar(24) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'complete', 'failed')),
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error varchar(500),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS object_operations_pending_idx
  ON object_operations(status, next_attempt_at, created_at);

CREATE TABLE IF NOT EXISTS qr_reference_claims (
  store_id uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  normalized_reference varchar(80) NOT NULL,
  first_qr_payment_id uuid NOT NULL REFERENCES qr_payments(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (store_id, normalized_reference)
);
INSERT INTO qr_reference_claims (store_id, normalized_reference, first_qr_payment_id, created_at)
SELECT DISTINCT ON (store_id, normalized_reference)
       store_id, normalized_reference, id, created_at
  FROM qr_payments
 ORDER BY store_id, normalized_reference, created_at, id
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS entity_changes (
  id bigserial PRIMARY KEY,
  store_id uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  sync_cursor bigint NOT NULL,
  entity_type varchar(40) NOT NULL,
  entity_id varchar(160) NOT NULL,
  operation varchar(16) NOT NULL CHECK (operation IN ('upsert', 'delete')),
  changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS entity_changes_store_cursor_idx ON entity_changes(store_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS entity_changes_store_sync_cursor_idx ON entity_changes(store_id, sync_cursor);
CREATE INDEX IF NOT EXISTS entity_changes_changed_idx ON entity_changes(changed_at);

ALTER TABLE products ADD CONSTRAINT products_id_store_unique UNIQUE (id, store_id);
ALTER TABLE customers ADD CONSTRAINT customers_id_store_unique UNIQUE (id, store_id);
ALTER TABLE sales ADD CONSTRAINT sales_id_store_unique UNIQUE (id, store_id);
ALTER TABLE product_units ADD CONSTRAINT product_units_id_store_unique UNIQUE (id, store_id);

ALTER TABLE product_units
  ADD CONSTRAINT product_units_product_store_fk
  FOREIGN KEY (product_id, store_id) REFERENCES products(id, store_id) NOT VALID;
ALTER TABLE sales
  ADD CONSTRAINT sales_customer_store_fk
  FOREIGN KEY (customer_id, store_id) REFERENCES customers(id, store_id) NOT VALID;
ALTER TABLE sale_items
  ADD CONSTRAINT sale_items_sale_store_fk
  FOREIGN KEY (sale_id, store_id) REFERENCES sales(id, store_id) NOT VALID,
  ADD CONSTRAINT sale_items_product_store_fk
  FOREIGN KEY (product_id, store_id) REFERENCES products(id, store_id) NOT VALID,
  ADD CONSTRAINT sale_items_unit_store_fk
  FOREIGN KEY (product_unit_id, store_id) REFERENCES product_units(id, store_id) NOT VALID;
ALTER TABLE inventory_movements
  ADD CONSTRAINT inventory_movements_product_store_fk
  FOREIGN KEY (product_id, store_id) REFERENCES products(id, store_id) NOT VALID,
  ADD CONSTRAINT inventory_movements_sale_store_fk
  FOREIGN KEY (sale_id, store_id) REFERENCES sales(id, store_id) NOT VALID,
  ADD CONSTRAINT inventory_movements_unit_store_fk
  FOREIGN KEY (product_unit_id, store_id) REFERENCES product_units(id, store_id) NOT VALID;
ALTER TABLE utang_entries
  ADD CONSTRAINT utang_entries_customer_store_fk
  FOREIGN KEY (customer_id, store_id) REFERENCES customers(id, store_id) NOT VALID,
  ADD CONSTRAINT utang_entries_sale_store_fk
  FOREIGN KEY (sale_id, store_id) REFERENCES sales(id, store_id) NOT VALID;
ALTER TABLE product_images
  ADD CONSTRAINT product_images_product_store_fk
  FOREIGN KEY (product_id, store_id) REFERENCES products(id, store_id) NOT VALID;
ALTER TABLE qr_payments
  ADD CONSTRAINT qr_payments_sale_store_fk
  FOREIGN KEY (sale_id, store_id) REFERENCES sales(id, store_id) NOT VALID;

ALTER TABLE product_units VALIDATE CONSTRAINT product_units_product_store_fk;
ALTER TABLE sales VALIDATE CONSTRAINT sales_customer_store_fk;
ALTER TABLE sale_items VALIDATE CONSTRAINT sale_items_sale_store_fk;
ALTER TABLE sale_items VALIDATE CONSTRAINT sale_items_product_store_fk;
ALTER TABLE sale_items VALIDATE CONSTRAINT sale_items_unit_store_fk;
ALTER TABLE inventory_movements VALIDATE CONSTRAINT inventory_movements_product_store_fk;
ALTER TABLE inventory_movements VALIDATE CONSTRAINT inventory_movements_sale_store_fk;
ALTER TABLE inventory_movements VALIDATE CONSTRAINT inventory_movements_unit_store_fk;
ALTER TABLE utang_entries VALIDATE CONSTRAINT utang_entries_customer_store_fk;
ALTER TABLE utang_entries VALIDATE CONSTRAINT utang_entries_sale_store_fk;
ALTER TABLE product_images VALIDATE CONSTRAINT product_images_product_store_fk;
ALTER TABLE qr_payments VALIDATE CONSTRAINT qr_payments_sale_store_fk;

ALTER TABLE sales ADD CONSTRAINT sales_discount_zero_check CHECK (discount = 0) NOT VALID;
ALTER TABLE sales VALIDATE CONSTRAINT sales_discount_zero_check;

CREATE OR REPLACE FUNCTION enforce_product_unit_ownership() RETURNS trigger AS $$
DECLARE
  candidate uuid;
BEGIN
  FOREACH candidate IN ARRAY ARRAY[NEW.base_unit_id, NEW.default_sale_unit_id, NEW.default_restock_unit_id, NEW.display_unit_id]
  LOOP
    IF candidate IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM product_units
       WHERE id = candidate AND product_id = NEW.id AND store_id = NEW.store_id
    ) THEN
      RAISE EXCEPTION 'Product unit % does not belong to product % in store %', candidate, NEW.id, NEW.store_id;
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS products_unit_ownership_trigger ON products;
CREATE CONSTRAINT TRIGGER products_unit_ownership_trigger
AFTER INSERT OR UPDATE OF base_unit_id, default_sale_unit_id, default_restock_unit_id, display_unit_id, store_id
ON products DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_product_unit_ownership();
