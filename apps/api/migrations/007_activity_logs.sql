CREATE TABLE IF NOT EXISTS activity_logs (
  id bigserial PRIMARY KEY,
  store_id uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_display_name_snapshot varchar(120) NOT NULL,
  actor_role_snapshot varchar(16) NOT NULL CHECK (actor_role_snapshot IN ('superadmin', 'owner', 'admin', 'cashier')),
  submitted_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  submitted_by_display_name_snapshot varchar(120),
  submitted_by_role_snapshot varchar(16) CHECK (submitted_by_role_snapshot IN ('superadmin', 'owner', 'admin', 'cashier')),
  device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
  device_name_snapshot varchar(120),
  category varchar(32) NOT NULL,
  action varchar(80) NOT NULL,
  entity_type varchar(80),
  entity_id varchar(160),
  summary varchar(240) NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  client_command_id uuid,
  occurred_at timestamptz NOT NULL,
  confirmed_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS activity_logs_command_idx
  ON activity_logs (store_id, device_id, client_command_id)
  WHERE client_command_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS activity_logs_store_id_idx
  ON activity_logs (store_id, id DESC);
CREATE INDEX IF NOT EXISTS activity_logs_store_created_idx
  ON activity_logs (store_id, occurred_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS activity_logs_store_category_idx
  ON activity_logs (store_id, category, id DESC);
CREATE INDEX IF NOT EXISTS activity_logs_store_actor_idx
  ON activity_logs (store_id, actor_user_id, id DESC);
