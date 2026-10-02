ALTER TABLE sales DROP CONSTRAINT IF EXISTS sales_payment_method_check;
ALTER TABLE sales
  ADD CONSTRAINT sales_payment_method_check
  CHECK (payment_method IN ('cash', 'qrph', 'gcash', 'maya', 'utang', 'other'));

CREATE TABLE IF NOT EXISTS qr_payments (
  id uuid PRIMARY KEY,
  store_id uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  sale_id uuid NOT NULL UNIQUE REFERENCES sales(id) ON DELETE CASCADE,
  cashier_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  cashier_display_name_snapshot varchar(120) NOT NULL,
  device_id uuid NOT NULL REFERENCES devices(id) ON DELETE RESTRICT,
  amount integer NOT NULL CHECK (amount >= 0),
  reference varchar(80) NOT NULL,
  normalized_reference varchar(80) NOT NULL,
  confirmation_source varchar(32) NOT NULL CHECK (confirmation_source IN ('merchant_notification', 'customer_proof')),
  status varchar(32) NOT NULL CHECK (status IN ('merchant_confirmed', 'pending_review', 'verified', 'rejected')),
  attention_reason varchar(32) CHECK (attention_reason IN ('customer_proof', 'duplicate_reference')),
  confirmed_at timestamptz NOT NULL,
  reviewed_at timestamptz,
  reviewed_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  review_note varchar(200),
  record_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS qr_payments_store_status_idx
  ON qr_payments(store_id, status, confirmed_at DESC);
CREATE INDEX IF NOT EXISTS qr_payments_store_reference_idx
  ON qr_payments(store_id, normalized_reference);
CREATE UNIQUE INDEX IF NOT EXISTS qr_payments_collected_reference_idx
  ON qr_payments(store_id, normalized_reference)
  WHERE status IN ('merchant_confirmed', 'verified');

CREATE TABLE IF NOT EXISTS qrph_payment_settings (
  store_id uuid PRIMARY KEY REFERENCES stores(id) ON DELETE CASCADE,
  image_revision uuid NOT NULL,
  object_key text NOT NULL UNIQUE,
  content_type varchar(40) NOT NULL CHECK (content_type IN ('image/png', 'image/webp', 'image/jpeg')),
  byte_length integer NOT NULL CHECK (byte_length > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL
);
