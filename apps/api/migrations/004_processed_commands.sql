CREATE TABLE IF NOT EXISTS processed_commands (
  store_id uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  device_id uuid NOT NULL,
  client_command_id uuid NOT NULL,
  command_type varchar(40) NOT NULL,
  result_json jsonb,
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (store_id, device_id, client_command_id),
  FOREIGN KEY (device_id, store_id) REFERENCES devices(id, store_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS processed_commands_store_processed_idx
  ON processed_commands (store_id, processed_at DESC);
