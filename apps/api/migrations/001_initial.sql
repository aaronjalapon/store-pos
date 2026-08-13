CREATE TABLE IF NOT EXISTS stores (
  id uuid PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS devices (
  id uuid PRIMARY KEY,
  store_id uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  name varchar(80) NOT NULL,
  enrolled_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, store_id)
);

CREATE TABLE IF NOT EXISTS backups (
  id uuid PRIMARY KEY,
  store_id uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  device_id uuid NOT NULL,
  schema_version integer NOT NULL CHECK (schema_version > 0),
  object_key text NOT NULL UNIQUE,
  byte_length integer NOT NULL CHECK (byte_length > 0),
  checksum_sha256 char(64) NOT NULL,
  created_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (device_id, store_id) REFERENCES devices(id, store_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS backups_store_created_idx
  ON backups (store_id, created_at DESC);
