ALTER TABLE stores
  ADD COLUMN IF NOT EXISTS name varchar(120),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

UPDATE stores SET name = COALESCE(name, 'Imported Store');

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY,
  display_name varchar(120) NOT NULL,
  email varchar(200) UNIQUE,
  password_hash text,
  staff_code varchar(32) UNIQUE,
  pin_hash text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_email_or_staff_code_required CHECK (email IS NOT NULL OR staff_code IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS store_memberships (
  store_id uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role varchar(16) NOT NULL CHECK (role IN ('owner', 'admin', 'cashier')),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (store_id, user_id)
);

ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS first_synced_at timestamptz,
  ADD COLUMN IF NOT EXISTS registered_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS products (
  id uuid PRIMARY KEY,
  store_id uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  barcode varchar(64),
  sku varchar(64),
  image_revision uuid,
  name varchar(160) NOT NULL,
  category varchar(80) NOT NULL,
  cost_price integer NOT NULL CHECK (cost_price >= 0),
  selling_price integer NOT NULL CHECK (selling_price >= 0),
  stock_quantity double precision NOT NULL CHECK (stock_quantity >= 0),
  unit varchar(40) NOT NULL,
  sold_by_weight boolean NOT NULL DEFAULT false,
  quantity_step double precision NOT NULL DEFAULT 1,
  low_stock_threshold double precision NOT NULL DEFAULT 0,
  is_quick_item boolean NOT NULL DEFAULT true,
  is_active boolean NOT NULL DEFAULT true,
  record_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS products_store_barcode_idx ON products(store_id, barcode) WHERE barcode IS NOT NULL;

CREATE TABLE IF NOT EXISTS customers (
  id uuid PRIMARY KEY,
  store_id uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  name varchar(120) NOT NULL,
  nickname varchar(120),
  phone_number varchar(40),
  notes text,
  is_active boolean NOT NULL DEFAULT true,
  record_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS sales (
  id uuid PRIMARY KEY,
  store_id uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  transaction_number varchar(64) NOT NULL,
  customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,
  cashier_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  device_id uuid NOT NULL REFERENCES devices(id) ON DELETE RESTRICT,
  subtotal integer NOT NULL CHECK (subtotal >= 0),
  discount integer NOT NULL CHECK (discount >= 0),
  total integer NOT NULL CHECK (total >= 0),
  payment_method varchar(16) NOT NULL CHECK (payment_method IN ('cash', 'gcash', 'maya', 'utang', 'other')),
  cash_received integer,
  change_amount integer,
  record_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS sales_store_transaction_idx ON sales(store_id, transaction_number);

CREATE TABLE IF NOT EXISTS sale_items (
  id uuid PRIMARY KEY,
  store_id uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  sale_id uuid NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  product_name_snapshot varchar(160) NOT NULL,
  quantity double precision NOT NULL CHECK (quantity > 0),
  unit_price integer NOT NULL CHECK (unit_price >= 0),
  cost_price_snapshot integer NOT NULL CHECK (cost_price_snapshot >= 0),
  subtotal integer NOT NULL CHECK (subtotal >= 0),
  record_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS inventory_movements (
  id uuid PRIMARY KEY,
  store_id uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  sale_id uuid REFERENCES sales(id) ON DELETE SET NULL,
  reason varchar(16) NOT NULL CHECK (reason IN ('sale', 'restock', 'adjustment', 'void')),
  quantity_delta double precision NOT NULL,
  stock_after double precision NOT NULL CHECK (stock_after >= 0),
  note varchar(200),
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  device_id uuid NOT NULL REFERENCES devices(id) ON DELETE RESTRICT,
  record_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS utang_entries (
  id uuid PRIMARY KEY,
  store_id uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  sale_id uuid REFERENCES sales(id) ON DELETE SET NULL,
  kind varchar(16) NOT NULL CHECK (kind IN ('purchase', 'payment', 'adjustment')),
  amount integer NOT NULL CHECK (amount > 0),
  note varchar(200),
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  record_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS expenses (
  id uuid PRIMARY KEY,
  store_id uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  category varchar(120) NOT NULL,
  description varchar(200) NOT NULL,
  amount integer NOT NULL CHECK (amount > 0),
  occurred_at timestamptz NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  record_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS product_images (
  store_id uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  revision uuid NOT NULL,
  object_key text NOT NULL UNIQUE,
  content_type varchar(40) NOT NULL CHECK (content_type IN ('image/webp', 'image/jpeg')),
  byte_length integer NOT NULL CHECK (byte_length > 0),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (store_id, product_id)
);

CREATE TABLE IF NOT EXISTS sync_events (
  id bigserial PRIMARY KEY,
  store_id uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  kind varchar(32) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sync_events_store_idx ON sync_events(store_id, id DESC);

ALTER TABLE backups
  ADD COLUMN IF NOT EXISTS checksum_sha256 char(64),
  ADD COLUMN IF NOT EXISTS object_key text,
  ADD COLUMN IF NOT EXISTS byte_length integer,
  ADD COLUMN IF NOT EXISTS schema_version integer,
  ADD COLUMN IF NOT EXISTS backup_kind varchar(32) NOT NULL DEFAULT 'server_snapshot';
