CREATE TABLE IF NOT EXISTS product_units (
  id uuid PRIMARY KEY,
  store_id uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name varchar(80) NOT NULL,
  symbol varchar(20),
  multiplier_base_units bigint NOT NULL CHECK (multiplier_base_units > 0),
  quantity_step numeric(20,9) NOT NULL CHECK (quantity_step > 0),
  can_sell boolean NOT NULL DEFAULT false,
  can_restock boolean NOT NULL DEFAULT false,
  allow_amount_pricing boolean NOT NULL DEFAULT false,
  selling_price integer CHECK (selling_price >= 0),
  cost_price integer CHECK (cost_price >= 0),
  barcode varchar(64),
  is_base boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  replaces_unit_id uuid REFERENCES product_units(id) ON DELETE SET NULL,
  record_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT product_units_price_required CHECK (NOT can_sell OR selling_price IS NOT NULL),
  CONSTRAINT product_units_step_is_base_aligned CHECK (
    (multiplier_base_units * quantity_step) = ROUND(multiplier_base_units * quantity_step)
  )
);
CREATE INDEX IF NOT EXISTS product_units_product_idx ON product_units(product_id, is_active);
CREATE UNIQUE INDEX IF NOT EXISTS product_units_store_active_barcode_idx
  ON product_units(store_id, barcode)
  WHERE barcode IS NOT NULL AND is_active;
CREATE UNIQUE INDEX IF NOT EXISTS product_units_product_base_idx
  ON product_units(product_id)
  WHERE is_base;

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS base_unit varchar(40),
  ADD COLUMN IF NOT EXISTS base_unit_id uuid,
  ADD COLUMN IF NOT EXISTS stock_base_quantity bigint,
  ADD COLUMN IF NOT EXISTS low_stock_base_threshold bigint,
  ADD COLUMN IF NOT EXISTS default_sale_unit_id uuid,
  ADD COLUMN IF NOT EXISTS default_restock_unit_id uuid,
  ADD COLUMN IF NOT EXISTS display_unit_id uuid;

WITH mapped AS (
  SELECT
    id,
    CASE lower(trim(unit)) WHEN 'kg' THEN 'g' WHEN 'kilogram' THEN 'g'
      WHEN 'liter' THEN 'milliliter' WHEN 'litre' THEN 'milliliter' ELSE trim(unit) END AS base_unit,
    CASE lower(trim(unit)) WHEN 'kg' THEN 1000 WHEN 'kilogram' THEN 1000
      WHEN 'liter' THEN 1000 WHEN 'litre' THEN 1000 ELSE 1 END::bigint AS multiplier
  FROM products
)
UPDATE products p
SET base_unit = mapped.base_unit,
    stock_base_quantity = ROUND(p.stock_quantity * mapped.multiplier)::bigint,
    low_stock_base_threshold = ROUND(p.low_stock_threshold * mapped.multiplier)::bigint
FROM mapped
WHERE p.id = mapped.id;

WITH mapped AS (
  SELECT
    p.id AS product_id,
    p.store_id,
    p.unit,
    p.cost_price,
    p.selling_price,
    p.sold_by_weight,
    p.quantity_step,
    p.created_at,
    p.updated_at,
    CASE lower(trim(p.unit)) WHEN 'kg' THEN 'g' WHEN 'kilogram' THEN 'g'
      WHEN 'liter' THEN 'milliliter' WHEN 'litre' THEN 'milliliter' ELSE trim(p.unit) END AS base_unit,
    CASE lower(trim(p.unit)) WHEN 'kg' THEN 1000 WHEN 'kilogram' THEN 1000
      WHEN 'liter' THEN 1000 WHEN 'litre' THEN 1000 ELSE 1 END::bigint AS multiplier,
    p.barcode
  FROM products p
)
INSERT INTO product_units (
  id, store_id, product_id, name, symbol, multiplier_base_units, quantity_step,
  can_sell, can_restock, allow_amount_pricing, selling_price, cost_price, barcode,
  is_base, is_active, record_version, created_at, updated_at
)
SELECT md5(mapped.product_id::text || ':base-unit')::uuid,
       mapped.store_id, mapped.product_id, mapped.base_unit, mapped.base_unit,
       1, 1,
       CASE WHEN mapped.multiplier = 1 THEN true ELSE false END,
       CASE WHEN mapped.multiplier = 1 THEN true ELSE false END,
       false,
       CASE WHEN mapped.multiplier = 1 THEN mapped.selling_price ELSE NULL END,
       CASE WHEN mapped.multiplier = 1 THEN mapped.cost_price ELSE NULL END,
       CASE WHEN mapped.multiplier = 1 THEN mapped.barcode ELSE NULL END,
       true, true, 1, mapped.created_at, mapped.updated_at
FROM mapped
ON CONFLICT (id) DO NOTHING;

WITH mapped AS (
  SELECT
    p.id AS product_id,
    p.store_id,
    p.unit,
    p.cost_price,
    p.selling_price,
    p.sold_by_weight,
    p.quantity_step,
    p.created_at,
    p.updated_at,
    CASE lower(trim(p.unit)) WHEN 'kg' THEN 1000 WHEN 'kilogram' THEN 1000
      WHEN 'liter' THEN 1000 WHEN 'litre' THEN 1000 ELSE 1 END::bigint AS multiplier,
    p.barcode
  FROM products p
)
INSERT INTO product_units (
  id, store_id, product_id, name, symbol, multiplier_base_units, quantity_step,
  can_sell, can_restock, allow_amount_pricing, selling_price, cost_price, barcode,
  is_base, is_active, record_version, created_at, updated_at
)
SELECT md5(mapped.product_id::text || ':legacy-unit')::uuid,
       mapped.store_id, mapped.product_id, mapped.unit, mapped.unit,
       mapped.multiplier, CASE WHEN mapped.multiplier = 1 THEN 1 ELSE mapped.quantity_step END,
       true, true, mapped.sold_by_weight,
       mapped.selling_price, mapped.cost_price, mapped.barcode,
       false, true, 1, mapped.created_at, mapped.updated_at
FROM mapped
WHERE mapped.multiplier <> 1
ON CONFLICT (id) DO NOTHING;

UPDATE products p
SET base_unit_id = md5(p.id::text || ':base-unit')::uuid,
    default_sale_unit_id = CASE WHEN lower(trim(p.unit)) IN ('kg', 'kilogram', 'liter', 'litre')
      THEN md5(p.id::text || ':legacy-unit')::uuid ELSE md5(p.id::text || ':base-unit')::uuid END,
    default_restock_unit_id = CASE WHEN lower(trim(p.unit)) IN ('kg', 'kilogram', 'liter', 'litre')
      THEN md5(p.id::text || ':legacy-unit')::uuid ELSE md5(p.id::text || ':base-unit')::uuid END,
    display_unit_id = CASE WHEN lower(trim(p.unit)) IN ('kg', 'kilogram', 'liter', 'litre')
      THEN md5(p.id::text || ':legacy-unit')::uuid ELSE md5(p.id::text || ':base-unit')::uuid END
WHERE p.base_unit_id IS NULL;

UPDATE products p
SET default_sale_unit_id = p.base_unit_id,
    default_restock_unit_id = p.base_unit_id,
    display_unit_id = p.base_unit_id
WHERE p.default_sale_unit_id IS NULL;

ALTER TABLE products
  ADD CONSTRAINT products_base_unit_id_fk FOREIGN KEY (base_unit_id) REFERENCES product_units(id),
  ADD CONSTRAINT products_default_sale_unit_id_fk FOREIGN KEY (default_sale_unit_id) REFERENCES product_units(id),
  ADD CONSTRAINT products_default_restock_unit_id_fk FOREIGN KEY (default_restock_unit_id) REFERENCES product_units(id),
  ADD CONSTRAINT products_display_unit_id_fk FOREIGN KEY (display_unit_id) REFERENCES product_units(id);

ALTER TABLE products
  ALTER COLUMN base_unit SET NOT NULL,
  ALTER COLUMN stock_base_quantity SET NOT NULL,
  ALTER COLUMN low_stock_base_threshold SET NOT NULL;

ALTER TABLE sale_items
  ADD COLUMN IF NOT EXISTS product_unit_id uuid,
  ADD COLUMN IF NOT EXISTS input_quantity numeric(20,9),
  ADD COLUMN IF NOT EXISTS unit_name_snapshot varchar(80),
  ADD COLUMN IF NOT EXISTS unit_symbol_snapshot varchar(20),
  ADD COLUMN IF NOT EXISTS multiplier_base_units_snapshot bigint,
  ADD COLUMN IF NOT EXISTS base_quantity bigint;

UPDATE sale_items si
SET product_unit_id = COALESCE(si.product_unit_id, p.default_sale_unit_id),
    input_quantity = COALESCE(si.input_quantity, si.quantity),
    unit_name_snapshot = COALESCE(si.unit_name_snapshot, pu.name),
    unit_symbol_snapshot = COALESCE(si.unit_symbol_snapshot, pu.symbol),
    multiplier_base_units_snapshot = COALESCE(si.multiplier_base_units_snapshot, pu.multiplier_base_units),
    base_quantity = COALESCE(si.base_quantity, ROUND(si.quantity * pu.multiplier_base_units)::bigint)
FROM products p
JOIN product_units pu ON pu.id = p.default_sale_unit_id
WHERE si.product_id = p.id;

ALTER TABLE inventory_movements
  ADD COLUMN IF NOT EXISTS product_unit_id uuid,
  ADD COLUMN IF NOT EXISTS input_mode varchar(16) NOT NULL DEFAULT 'delta',
  ADD COLUMN IF NOT EXISTS input_quantity numeric(20,9),
  ADD COLUMN IF NOT EXISTS input_unit_snapshot varchar(80),
  ADD COLUMN IF NOT EXISTS multiplier_base_units_snapshot bigint,
  ADD COLUMN IF NOT EXISTS base_quantity_delta bigint,
  ADD COLUMN IF NOT EXISTS stock_after_base bigint,
  ADD COLUMN IF NOT EXISTS adjustment_reason varchar(32),
  ADD COLUMN IF NOT EXISTS actor_display_name_snapshot varchar(120);

UPDATE inventory_movements im
SET product_unit_id = COALESCE(im.product_unit_id, p.default_sale_unit_id),
    input_quantity = COALESCE(im.input_quantity, ABS(im.quantity_delta)),
    input_unit_snapshot = COALESCE(im.input_unit_snapshot, pu.name),
    multiplier_base_units_snapshot = COALESCE(im.multiplier_base_units_snapshot, pu.multiplier_base_units),
    base_quantity_delta = COALESCE(im.base_quantity_delta, ROUND(im.quantity_delta * pu.multiplier_base_units)::bigint),
    stock_after_base = COALESCE(im.stock_after_base, ROUND(im.stock_after * pu.multiplier_base_units)::bigint),
    actor_display_name_snapshot = COALESCE(im.actor_display_name_snapshot, 'Legacy record')
FROM products p
JOIN product_units pu ON pu.id = p.default_sale_unit_id
WHERE im.product_id = p.id;

ALTER TABLE sale_items
  ADD CONSTRAINT sale_items_product_unit_fk FOREIGN KEY (product_unit_id) REFERENCES product_units(id),
  ADD CONSTRAINT sale_items_base_quantity_check CHECK (base_quantity IS NULL OR base_quantity > 0);

ALTER TABLE inventory_movements
  ADD CONSTRAINT inventory_movements_product_unit_fk FOREIGN KEY (product_unit_id) REFERENCES product_units(id),
  ADD CONSTRAINT inventory_movements_input_mode_check CHECK (input_mode IN ('delta', 'absolute'));

CREATE INDEX IF NOT EXISTS inventory_movements_product_created_idx
  ON inventory_movements(product_id, created_at DESC, id DESC);
