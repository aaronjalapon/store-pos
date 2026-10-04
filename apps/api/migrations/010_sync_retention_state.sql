CREATE TABLE IF NOT EXISTS store_sync_state (
  store_id uuid PRIMARY KEY REFERENCES stores(id) ON DELETE CASCADE,
  min_available_cursor bigint NOT NULL DEFAULT 0 CHECK (min_available_cursor >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO store_sync_state (store_id)
SELECT id FROM stores
ON CONFLICT (store_id) DO NOTHING;
