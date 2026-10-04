import { ConflictException, ForbiddenException, Injectable, Optional } from '@nestjs/common';
import type {
  CommandConflictReason,
  Product,
  QrPayment,
  StoreCommand,
  StoreCommandRequest,
  StoreCommandResponse,
} from '@gma/contracts';
import { DatabaseService } from '../database/database.service';
import type { SessionPrincipal } from '../auth/auth.types';
import { StoreDataService } from '../stores/store-data.service';
import { AuthService } from '../auth/auth.service';
import { ActivityService } from '../activity/activity.service';

interface ProductRow {
  id: string;
  store_id: string;
  barcode: string | null;
  sku: string | null;
  image_revision: string | null;
  name: string;
  category: string;
  cost_price: number;
  selling_price: number;
  stock_quantity: number;
  unit: string;
  sold_by_weight: boolean;
  quantity_step: number;
  low_stock_threshold: number;
  is_quick_item: boolean;
  is_active: boolean;
  record_version: number;
  created_at: Date;
  updated_at: Date;
  base_unit: string | null;
  base_unit_id: string | null;
  stock_base_quantity: string | number | null;
  low_stock_base_threshold: string | number | null;
  default_sale_unit_id: string | null;
  default_restock_unit_id: string | null;
  display_unit_id: string | null;
}

interface ProductUnitRow {
  id: string;
  store_id: string;
  product_id: string;
  name: string;
  symbol: string | null;
  multiplier_base_units: string | number;
  quantity_step: string | number;
  can_sell: boolean;
  can_restock: boolean;
  allow_amount_pricing: boolean;
  selling_price: number | null;
  cost_price: number | null;
  barcode: string | null;
  is_base: boolean;
  is_active: boolean;
  replaces_unit_id: string | null;
  record_version: number;
}

interface CustomerRow {
  id: string;
  record_version: number;
  is_active: boolean;
  name: string;
}

interface QrPaymentRow {
  id: string;
  status: QrPayment['status'];
  normalized_reference: string;
  record_version: number;
}

interface ProcessedCommandRow {
  result_json: Record<string, unknown> | null;
}

@Injectable()
export class PosService {
  constructor(
    private readonly database: DatabaseService,
    private readonly data: StoreDataService,
    @Optional() private readonly auth?: AuthService,
    @Optional() private readonly activity?: ActivityService,
  ) {}

  async applyCommand(
    principal: SessionPrincipal,
    request: StoreCommandRequest,
    includeSnapshot = true,
  ): Promise<StoreCommandResponse> {
    const actor = await this.resolveCommandActor(principal, request);
    if (request.command.type === 'adjustStock') {
      this.requireRole(actor, ['owner', 'admin']);
      if (!this.auth) throw new ForbiddenException('Password approval is unavailable');
      await this.auth.verifyManagerActionProof(actor, request.managerApprovalProof, 'adjust_stock', request.clientCommandId);
    }
    const bootstrapped = await this.database.query<{ first_synced_at: Date | null }>(
      'SELECT first_synced_at FROM devices WHERE id = $1 AND store_id = $2',
      [actor.deviceId, actor.storeId],
    );
    if (!bootstrapped.rows[0]?.first_synced_at) {
      return this.conflict(actor.storeId, 'device_not_bootstrapped', 'This browser must finish its first sync before it can save offline work.', includeSnapshot);
    }

    try {
      const result = await this.database.transaction(async (client) => {
        const claim = await client.query(
          `INSERT INTO processed_commands
           (store_id, device_id, client_command_id, command_type, result_json)
           VALUES ($1, $2, $3, $4, NULL)
           ON CONFLICT (store_id, device_id, client_command_id) DO NOTHING
           RETURNING client_command_id`,
          [actor.storeId, actor.deviceId, request.clientCommandId, request.command.type],
        );
        if (!claim.rows[0]) {
          const existing = await client.query<ProcessedCommandRow>(
            `SELECT result_json
               FROM processed_commands
              WHERE store_id = $1 AND device_id = $2 AND client_command_id = $3`,
            [actor.storeId, actor.deviceId, request.clientCommandId],
          );
          if (!existing.rows[0]?.result_json) throw new Error('Processed command result is unavailable');
          return existing.rows[0].result_json;
        }

        let commandResult: Record<string, unknown>;
        switch (request.command.type) {
          case 'saveProduct':
            this.requireRole(actor, ['owner', 'admin']);
            commandResult = await this.saveProduct(client, actor, request.command);
            break;
          case 'completeSale':
            commandResult = await this.completeSale(client, actor, request.command);
            break;
          case 'reviewQrPayment':
            this.requireRole(actor, ['owner', 'admin']);
            commandResult = await this.reviewQrPayment(client, actor, request.command);
            break;
          case 'adjustStock':
            this.requireRole(actor, ['owner', 'admin']);
            commandResult = await this.adjustStock(client, actor, request.command.payload.productId, request.command.payload.newQuantity, request.command.payload.note, request.command.payload.expectedVersion);
            break;
          case 'restockProduct':
            this.requireRole(actor, ['owner', 'admin']);
            commandResult = await this.restockProduct(client, actor, request.command.payload.productId, request.command.payload.mode, request.command.payload.quantity, request.command.payload.note, request.command.payload.expectedVersion);
            break;
          case 'receiveStock':
            this.requireRole(actor, ['owner', 'admin']);
            commandResult = await this.receiveStock(client, actor, request.command.payload.productId, request.command.payload.productUnitId, request.command.payload.inputQuantity, request.command.payload.note);
            break;
          case 'countStock':
            this.requireRole(actor, ['owner', 'admin']);
            commandResult = await this.countStock(client, actor, request.command.payload);
            break;
          case 'adjustStockDelta':
            this.requireRole(actor, ['owner', 'admin']);
            commandResult = await this.adjustStockDelta(client, actor, request.command.payload);
            break;
          case 'createCustomer':
            commandResult = await this.createCustomer(client, actor, request.command.payload.name);
            break;
          case 'recordUtangPayment':
            this.requireRole(actor, ['owner', 'admin']);
            commandResult = await this.recordUtangPayment(client, actor, request.command.payload.customerId, request.command.payload.amount, request.command.payload.note);
            break;
          case 'recordExpense':
            this.requireRole(actor, ['owner', 'admin']);
            commandResult = await this.recordExpense(client, actor, request.command.payload.category, request.command.payload.description, request.command.payload.amount, request.command.payload.occurredAt);
            break;
          default:
            throw new ConflictException('Unsupported command');
        }
        await this.recordCommandActivity(client, actor, principal, request, commandResult);
        await client.query(
          `UPDATE processed_commands
              SET result_json = $4::jsonb, processed_at = now()
            WHERE store_id = $1 AND device_id = $2 AND client_command_id = $3`,
          [actor.storeId, actor.deviceId, request.clientCommandId, JSON.stringify(commandResult)],
        );
        return commandResult;
      });
      const cursor = await this.data.currentCursor(actor.storeId);
      const snapshot = includeSnapshot ? await this.data.loadBrowserSnapshot(actor.storeId) : undefined;
      return { status: 'applied', cursor, ...(snapshot ? { snapshot } : {}), ...result };
    } catch (error) {
      if (error instanceof StaleConflict) {
        return this.conflict(actor.storeId, error.reason, error.message, includeSnapshot);
      }
      throw error;
    }
  }

  private async saveProduct(client: { query: DatabaseService['query'] }, principal: SessionPrincipal, command: Extract<StoreCommand, { type: 'saveProduct' }>) {
    const payload = command.payload;
    const now = new Date().toISOString();
    const existing = payload.id
      ? await client.query<ProductRow>('SELECT * FROM products WHERE id = $1 AND store_id = $2', [payload.id, principal.storeId])
      : { rows: [] as ProductRow[] };
    const current = existing.rows[0];
    const canonicalPayload = Boolean(payload.baseUnit || payload.units?.length || payload.stockBaseQuantity !== undefined);
    const legacyMultiplier = this.legacyDisplayMultiplier({ unit: payload.unit } as ProductRow);
    const canonicalValues = {
      baseUnit: payload.baseUnit?.trim() || this.legacyBaseUnit(payload.unit),
      stockBaseQuantity: payload.stockBaseQuantity ?? Math.round(payload.stockQuantity * legacyMultiplier),
      lowStockBaseThreshold: payload.lowStockBaseThreshold ?? Math.round(payload.lowStockThreshold * legacyMultiplier),
    };
    if (current && command.expectedVersion && current.record_version !== command.expectedVersion) {
      throw new StaleConflict('stale_product', `${current.name} was updated on another device. Refresh and try again.`);
    }
    if (!current && command.expectedVersion) {
      throw new StaleConflict('not_found', 'This product no longer exists.');
    }
    this.validateStockQuantity(payload.soldByWeight, payload.quantityStep, payload.stockQuantity, payload.unit);
    const barcodeOwner = payload.barcode
      ? await client.query<{ id: string }>(
        'SELECT id FROM products WHERE store_id = $1 AND barcode = $2 AND ($3::uuid IS NULL OR id <> $3::uuid) LIMIT 1',
        [principal.storeId, payload.barcode.trim(), payload.id ?? null],
      )
      : { rows: [] as { id: string }[] };
    if (barcodeOwner.rows[0]) throw new ConflictException('That barcode is already assigned to another product');
    const id = payload.id ?? crypto.randomUUID();
    if (current) {
      await client.query(
        `UPDATE products SET
           barcode = $3,
           image_revision = $4,
           name = $5,
           category = $6,
           cost_price = $7,
           selling_price = $8,
           stock_quantity = CASE WHEN $18 THEN stock_quantity ELSE $9 END,
           unit = $10,
           sold_by_weight = $11,
           quantity_step = $12,
           low_stock_threshold = $13,
           is_quick_item = $14,
           is_active = $15,
           record_version = record_version + 1,
           updated_at = $16,
           updated_by_user_id = $17
         WHERE id = $1 AND store_id = $2`,
        [
          id,
          principal.storeId,
          payload.barcode?.trim() || null,
          payload.imageRevision ?? current.image_revision,
          payload.name.trim(),
          payload.category.trim() || 'Other',
          payload.costPrice,
          payload.sellingPrice,
          payload.stockQuantity,
          payload.unit.trim() || 'piece',
          payload.soldByWeight,
          payload.soldByWeight ? payload.quantityStep : 1,
          payload.lowStockThreshold,
          payload.isQuickItem,
          payload.isActive,
          now,
          principal.userId,
          canonicalPayload,
        ],
      );
    } else {
      await client.query(
        `INSERT INTO products
         (id, store_id, barcode, sku, image_revision, name, category, cost_price, selling_price, stock_quantity, unit,
          sold_by_weight, quantity_step, low_stock_threshold, is_quick_item, is_active, record_version, created_at, updated_at, created_by_user_id, updated_by_user_id,
          base_unit, stock_base_quantity, low_stock_base_threshold)
         VALUES ($1, $2, $3, NULL, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 1, $16, $16, $17, $17, $18, $19, $20)`,
        [
          id,
          principal.storeId,
          payload.barcode?.trim() || null,
          payload.imageRevision ?? null,
          payload.name.trim(),
          payload.category.trim() || 'Other',
          payload.costPrice,
          payload.sellingPrice,
          payload.stockQuantity,
          payload.unit.trim() || 'piece',
          payload.soldByWeight,
          payload.soldByWeight ? payload.quantityStep : 1,
          payload.lowStockThreshold,
          payload.isQuickItem,
          payload.isActive,
          now,
          principal.userId,
          canonicalValues.baseUnit,
          canonicalValues.stockBaseQuantity,
          canonicalValues.lowStockBaseThreshold,
        ],
      );
    }
    if (payload.baseUnit || payload.units?.length || payload.stockBaseQuantity !== undefined) {
      await client.query(
        `UPDATE products SET base_unit = $3, stock_base_quantity = $4, low_stock_base_threshold = $5,
          base_unit_id = COALESCE($6, base_unit_id), default_sale_unit_id = COALESCE($7, default_sale_unit_id),
          default_restock_unit_id = COALESCE($8, default_restock_unit_id), display_unit_id = COALESCE($9, display_unit_id)
         WHERE id = $1 AND store_id = $2`,
        [
          id,
          principal.storeId,
          canonicalValues.baseUnit,
          canonicalValues.stockBaseQuantity,
          canonicalValues.lowStockBaseThreshold,
          null,
          null,
          null,
          null,
        ],
      );
      for (const unit of payload.units ?? []) {
        const unitId = unit.id ?? crypto.randomUUID();
        await client.query(
          `INSERT INTO product_units
             (id, store_id, product_id, name, symbol, multiplier_base_units, quantity_step,
              can_sell, can_restock, allow_amount_pricing, selling_price, cost_price, barcode,
              is_base, is_active, replaces_unit_id, record_version, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, 1, $17, $17)
           ON CONFLICT (id) DO UPDATE SET
             name = EXCLUDED.name, symbol = EXCLUDED.symbol, multiplier_base_units = EXCLUDED.multiplier_base_units,
             quantity_step = EXCLUDED.quantity_step, can_sell = EXCLUDED.can_sell, can_restock = EXCLUDED.can_restock,
             allow_amount_pricing = EXCLUDED.allow_amount_pricing, selling_price = EXCLUDED.selling_price,
             cost_price = EXCLUDED.cost_price, barcode = EXCLUDED.barcode, is_base = EXCLUDED.is_base,
             is_active = EXCLUDED.is_active, replaces_unit_id = EXCLUDED.replaces_unit_id,
             record_version = product_units.record_version + 1, updated_at = EXCLUDED.updated_at`,
          [unitId, principal.storeId, id, unit.name.trim(), unit.symbol?.trim() || null, unit.multiplierBaseUnits,
            unit.quantityStep, unit.canSell, unit.canRestock, unit.allowAmountPricing, unit.sellingPrice ?? null,
            unit.costPrice ?? null, unit.barcode?.trim() || null, unit.isBase, unit.isActive, unit.replacesUnitId ?? null, now],
        );
      }
      const baseUnitId = payload.units?.find((unit) => unit.isBase)?.id;
      if (baseUnitId) await client.query('UPDATE products SET base_unit_id = $3 WHERE id = $1 AND store_id = $2', [id, principal.storeId, baseUnitId]);
      if (payload.defaultSaleUnitId || payload.defaultRestockUnitId || payload.displayUnitId) {
        await client.query(
          `UPDATE products SET default_sale_unit_id = COALESCE($3, default_sale_unit_id),
             default_restock_unit_id = COALESCE($4, default_restock_unit_id), display_unit_id = COALESCE($5, display_unit_id)
           WHERE id = $1 AND store_id = $2`,
          [id, principal.storeId, payload.defaultSaleUnitId ?? null, payload.defaultRestockUnitId ?? null, payload.displayUnitId ?? null],
        );
      }
    }
    await this.data.createSyncEvent(client, principal.storeId, 'product');
    return { productId: id, message: current ? 'Product updated.' : 'Product created.' };
  }

  private async completeSale(client: { query: DatabaseService['query'] }, principal: SessionPrincipal, command: Extract<StoreCommand, { type: 'completeSale' }>) {
    if (!command.payload.cart.length) throw new ConflictException('Cart is empty');
    if (command.payload.paymentMethod === 'utang' && !command.payload.customerId) {
      throw new ConflictException('Select an utang customer');
    }
    if (command.payload.paymentMethod === 'qrph' && !command.payload.qrPayment) {
      throw new ConflictException('QR Ph payment details are required');
    }
    const productsResult = await client.query<ProductRow>(
      'SELECT * FROM products WHERE store_id = $1 AND id = ANY($2::uuid[]) ORDER BY id FOR UPDATE',
      [principal.storeId, command.payload.cart.map((line) => line.productId)],
    );
    const products = new Map(productsResult.rows.map((row) => [row.id, row]));
    const unitIds = command.payload.cart.map((line) => line.productUnitId).filter((id): id is string => Boolean(id));
    const unitsResult = unitIds.length
      ? await client.query<ProductUnitRow>('SELECT * FROM product_units WHERE store_id = $1 AND id = ANY($2::uuid[])', [principal.storeId, unitIds])
      : { rows: [] as ProductUnitRow[] };
    const units = new Map(unitsResult.rows.map((row) => [row.id, row]));
    const preparedLines = command.payload.cart.map((line) => {
      const product = products.get(line.productId);
      if (!product || !product.is_active) {
        throw new StaleConflict('not_found', 'One of the products in this sale is no longer available.');
      }
      const unit = line.productUnitId ? units.get(line.productUnitId) : undefined;
      if (line.productUnitId && !unit) throw new StaleConflict('not_found', 'One of the selected selling units is no longer available.');
      if (unit && unit.product_id !== product.id) {
        throw new StaleConflict('unit_product_mismatch', `${unit.name} does not belong to ${product.name}.`);
      }
      if (unit && (!unit.is_active || !unit.can_sell)) {
        throw new StaleConflict('inactive_unit', `${unit.name} is no longer available for sale.`);
      }
      return unit ? this.prepareCanonicalSaleLine(product, unit, line) : this.prepareSaleLine(product, line);
    });
    const requestedByProduct = new Map<string, number>();
    for (const line of preparedLines) {
      requestedByProduct.set(line.product.id, (requestedByProduct.get(line.product.id) ?? 0) + line.baseQuantity);
    }
    for (const [productId, requested] of requestedByProduct) {
      const product = products.get(productId)!;
      if (requested > this.currentBaseStock(product)) {
        throw new StaleConflict('stale_product', `Only ${this.currentBaseStock(product)} base units of ${product.name} remain.`);
      }
    }
    const subtotal = preparedLines.reduce((sum, line) => sum + line.subtotal, 0);
    const discount = 0;
    const total = subtotal - discount;
    const change = command.payload.paymentMethod === 'cash'
      ? this.calculateChange(total, command.payload.cashReceived ?? 0)
      : null;
    if (command.payload.paymentMethod === 'cash' && change === null) throw new ConflictException('Cash received is less than the total');

    const saleId = command.payload.saleId;
    const now = command.payload.occurredAt;
    const transactionNumber = command.payload.transactionNumber;
    await client.query(
      `INSERT INTO sales
       (id, store_id, transaction_number, customer_id, cashier_user_id, device_id, subtotal, discount, total,
        payment_method, cash_received, change_amount, record_version, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 1, $13, $13)`,
      [
        saleId, principal.storeId, transactionNumber, command.payload.customerId,
        principal.userId, principal.deviceId, subtotal, discount, total,
        command.payload.paymentMethod, command.payload.cashReceived, change, now,
      ],
    );

    let qrPaymentStatus: QrPayment['status'] | null = null;
    if (command.payload.paymentMethod === 'qrph' && command.payload.qrPayment) {
      const qr = command.payload.qrPayment;
      const normalizedReference = this.normalizeQrReference(qr.reference);
      if (!normalizedReference) throw new ConflictException('Enter a valid QR Ph reference number');
      const requestedStatus: QrPayment['status'] = qr.confirmationSource === 'merchant_notification'
        ? 'merchant_confirmed'
        : 'pending_review';
      const requestedReason: QrPayment['attentionReason'] = qr.confirmationSource === 'customer_proof'
        ? 'customer_proof'
        : null;
      await client.query(
        `INSERT INTO qr_payments
         (id, store_id, sale_id, cashier_user_id, cashier_display_name_snapshot, device_id, amount, reference, normalized_reference,
          confirmation_source, status, attention_reason, confirmed_at, record_version, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending_review', $11, $12, 1, $12, $12)`,
        [qr.id, principal.storeId, saleId, principal.userId, principal.displayName, principal.deviceId, total, qr.reference.trim(), normalizedReference,
          qr.confirmationSource, requestedReason, now],
      );
      const claim = await client.query(
        `INSERT INTO qr_reference_claims (store_id, normalized_reference, first_qr_payment_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (store_id, normalized_reference) DO NOTHING
         RETURNING first_qr_payment_id`,
        [principal.storeId, normalizedReference, qr.id],
      );
      if (claim.rows[0]) {
        await client.query(
          'UPDATE qr_payments SET status = $2, attention_reason = $3, updated_at = $4 WHERE id = $1',
          [qr.id, requestedStatus, requestedReason, now],
        );
        qrPaymentStatus = requestedStatus;
      } else {
        await client.query(
          `UPDATE qr_payments
              SET status = 'pending_review', attention_reason = 'duplicate_reference', updated_at = $2
            WHERE id = $1`,
          [qr.id, now],
        );
        qrPaymentStatus = 'pending_review';
      }
    }

    const runningBase = new Map<string, number>();
    for (const line of preparedLines) {
      const product = line.product;
      const stockAfterBase = (runningBase.get(product.id) ?? this.currentBaseStock(product)) - line.baseQuantity;
      if (stockAfterBase < 0) {
        throw new StaleConflict('stale_product', `Only ${this.currentBaseStock(product)} base units of ${product.name} remain.`);
      }
      runningBase.set(product.id, stockAfterBase);
      const stockAfter = this.normalizeQuantity(stockAfterBase / this.legacyDisplayMultiplier(product));
      await client.query(
        `INSERT INTO sale_items
         (id, store_id, sale_id, product_id, product_name_snapshot, quantity, unit_price, cost_price_snapshot, subtotal, record_version, created_at, updated_at,
          product_unit_id, input_quantity, unit_name_snapshot, unit_symbol_snapshot, multiplier_base_units_snapshot, base_quantity)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1, $10, $10, $11, $12, $13, $14, $15, $16)`,
        [crypto.randomUUID(), principal.storeId, saleId, product.id, product.name, line.quantity,
          line.unit?.selling_price ?? product.selling_price, line.unit?.cost_price ?? product.cost_price,
          line.subtotal, now, line.unit?.id ?? null, line.inputQuantity ?? line.quantity,
          line.unit?.name ?? product.unit, line.unit?.symbol ?? product.unit,
          line.unit?.multiplier_base_units ?? 1, line.baseQuantity ?? Math.round(line.quantity)],
      );
      await client.query(
        `INSERT INTO inventory_movements
         (id, store_id, product_id, sale_id, reason, quantity_delta, stock_after, note, actor_user_id, device_id, record_version, created_at, updated_at,
          product_unit_id, input_mode, input_quantity, input_unit_snapshot, multiplier_base_units_snapshot, base_quantity_delta, stock_after_base, actor_display_name_snapshot)
         VALUES ($1, $2, $3, $4, 'sale', $5, $6, $7, $8, $9, 1, $10, $10, $11, 'delta', $12, $13, $14, $15, $16, $17)`,
        [crypto.randomUUID(), principal.storeId, product.id, saleId,
          line.unit ? -line.baseQuantity : -line.quantity, stockAfter, transactionNumber,
          principal.userId, principal.deviceId, now, line.unit?.id ?? null,
          line.inputQuantity ?? line.quantity, line.unit?.name ?? product.unit,
          line.unit?.multiplier_base_units ?? 1, -line.baseQuantity,
          stockAfterBase, principal.displayName],
      );
    }

    for (const [productId, stockAfterBase] of runningBase) {
      const product = products.get(productId)!;
      const stockAfter = this.normalizeQuantity(stockAfterBase / this.legacyDisplayMultiplier(product));
      await client.query(
        `UPDATE products
            SET stock_quantity = $3,
                stock_base_quantity = $6,
                record_version = record_version + 1,
                updated_at = $4,
                updated_by_user_id = $5
          WHERE id = $1 AND store_id = $2`,
        [product.id, principal.storeId, stockAfter, now, principal.userId, stockAfterBase],
      );
    }

    if (command.payload.paymentMethod === 'utang' && command.payload.customerId) {
      const customer = await client.query<CustomerRow>(
        'SELECT id, record_version, is_active, name FROM customers WHERE id = $1 AND store_id = $2',
        [command.payload.customerId, principal.storeId],
      );
      if (!customer.rows[0]?.is_active) throw new StaleConflict('stale_customer', 'The selected customer is no longer active.');
      await client.query(
        `INSERT INTO utang_entries
         (id, store_id, customer_id, sale_id, kind, amount, note, actor_user_id, record_version, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'purchase', $5, $6, $7, 1, $8, $8)`,
        [crypto.randomUUID(), principal.storeId, command.payload.customerId, saleId, total, transactionNumber, principal.userId, now],
      );
    }

    await this.data.createSyncEvent(client, principal.storeId, 'sale');
    return { saleId, qrPaymentStatus, message: qrPaymentStatus === 'pending_review' ? 'Sale completed. QR Ph payment needs review.' : 'Sale completed.' };
  }

  private async reviewQrPayment(
    client: { query: DatabaseService['query'] },
    principal: SessionPrincipal,
    command: Extract<StoreCommand, { type: 'reviewQrPayment' }>,
  ) {
    const current = await client.query<QrPaymentRow>(
      'SELECT id, status, normalized_reference, record_version FROM qr_payments WHERE id = $1 AND store_id = $2 FOR UPDATE',
      [command.payload.paymentId, principal.storeId],
    );
    const payment = current.rows[0];
    if (!payment) throw new StaleConflict('not_found', 'This QR Ph payment no longer exists.');
    if (payment.record_version !== command.payload.expectedVersion) {
      throw new StaleConflict('validation_failed', 'This QR Ph payment was reviewed on another device. Refresh and try again.');
    }
    if (payment.status !== 'pending_review') {
      throw new StaleConflict('validation_failed', 'Only pending QR Ph payments can be reviewed.');
    }
    if (command.payload.decision === 'reject' && !command.payload.note.trim()) {
      throw new ConflictException('A rejection note is required');
    }
    if (command.payload.decision === 'verify') {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${principal.storeId}:${payment.normalized_reference}`]);
      const claimed = await client.query<{ id: string }>(
        `SELECT id FROM qr_payments
          WHERE store_id = $1 AND normalized_reference = $2 AND id <> $3
            AND status IN ('merchant_confirmed', 'verified')
          LIMIT 1`,
        [principal.storeId, payment.normalized_reference, payment.id],
      );
      if (claimed.rows[0]) throw new StaleConflict('validation_failed', 'This reference is already collected by another sale. Reject the duplicate payment instead.');
    }
    const status: QrPayment['status'] = command.payload.decision === 'verify' ? 'verified' : 'rejected';
    const now = new Date().toISOString();
    await client.query(
      `UPDATE qr_payments
          SET status = $3, attention_reason = NULL, reviewed_at = $4, reviewed_by_user_id = $5,
              review_note = $6, record_version = record_version + 1, updated_at = $4
        WHERE id = $1 AND store_id = $2`,
      [payment.id, principal.storeId, status, now, principal.userId, command.payload.note.trim() || null],
    );
    await this.data.createSyncEvent(client, principal.storeId, 'qr_payment_review');
    return { paymentId: payment.id, qrPaymentStatus: status, message: status === 'verified' ? 'QR Ph payment verified.' : 'QR Ph payment marked unpaid.' };
  }

  private async adjustStock(client: { query: DatabaseService['query'] }, principal: SessionPrincipal, productId: string, newQuantity: number, note: string, expectedVersion: number) {
    const product = await this.requireProduct(client, principal.storeId, productId);
    if (product.record_version !== expectedVersion) {
      throw new StaleConflict('stale_product', `${product.name} changed on another device. Refresh before saving stock.`);
    }
    this.validateStockQuantity(product.sold_by_weight, product.quantity_step, newQuantity, product.unit);
    const now = new Date().toISOString();
    const stockAfterBase = Math.round(newQuantity * this.legacyDisplayMultiplier(product));
    await client.query(
      `UPDATE products
          SET stock_quantity = $3,
              stock_base_quantity = CASE WHEN stock_base_quantity IS NULL THEN stock_base_quantity ELSE $6 END,
              record_version = record_version + 1,
              updated_at = $4,
              updated_by_user_id = $5
        WHERE id = $1 AND store_id = $2`,
      [productId, principal.storeId, newQuantity, now, principal.userId, stockAfterBase],
    );
    await client.query(
      `INSERT INTO inventory_movements
       (id, store_id, product_id, sale_id, reason, quantity_delta, stock_after, note, actor_user_id, device_id, record_version, created_at, updated_at)
       VALUES ($1, $2, $3, NULL, $4, $5, $6, $7, $8, $9, 1, $10, $10)`,
      [
        crypto.randomUUID(),
        principal.storeId,
        productId,
        newQuantity >= product.stock_quantity ? 'restock' : 'adjustment',
        this.normalizeQuantity(newQuantity - product.stock_quantity),
        newQuantity,
        note || 'Manual stock adjustment',
        principal.userId,
        principal.deviceId,
        now,
      ],
    );
    await this.data.createSyncEvent(client, principal.storeId, 'inventory');
    return { message: 'Stock updated.' };
  }

  private async restockProduct(
    client: { query: DatabaseService['query'] },
    principal: SessionPrincipal,
    productId: string,
    mode: 'add' | 'set',
    quantity: number,
    note: string,
    expectedVersion: number,
  ) {
    const product = await this.requireProduct(client, principal.storeId, productId);
    if (product.record_version !== expectedVersion) {
      throw new StaleConflict('stale_product', `${product.name} changed on another device. Refresh before restocking.`);
    }
    const nextQuantity = mode === 'add' ? this.normalizeQuantity(product.stock_quantity + quantity) : quantity;
    this.validateStockQuantity(product.sold_by_weight, product.quantity_step, nextQuantity, product.unit);
    return this.adjustStock(client, principal, productId, nextQuantity, note, expectedVersion);
  }

  private async receiveStock(
    client: { query: DatabaseService['query'] },
    principal: SessionPrincipal,
    productId: string,
    productUnitId: string,
    inputQuantity: number,
    note: string,
  ) {
    const product = await this.requireProductForUpdate(client, principal.storeId, productId);
    if (!product.is_active) throw new ConflictException(`${product.name} is inactive and cannot be restocked.`);
    const unit = await this.requireProductUnit(client, principal.storeId, productId, productUnitId, true);
    const baseDelta = this.convertInputToBase(unit, inputQuantity);
    const nextBase = this.currentBaseStock(product) + baseDelta;
    const now = new Date().toISOString();
    await this.updateCanonicalStock(client, principal, product, nextBase, now);
    await this.insertCanonicalMovement(client, principal, {
      product, unit, reason: 'restock', inputMode: 'delta', inputQuantity,
      baseQuantityDelta: baseDelta, stockAfterBase: nextBase, note: note || 'Stock received', now,
    });
    await this.data.createSyncEvent(client, principal.storeId, 'inventory');
    return { message: 'Stock received.' };
  }

  private async countStock(
    client: { query: DatabaseService['query'] },
    principal: SessionPrincipal,
    payload: Extract<StoreCommand, { type: 'countStock' }>['payload'],
  ) {
    const product = await this.requireProductForUpdate(client, principal.storeId, payload.productId);
    if (product.record_version !== payload.expectedVersion) {
      throw new StaleConflict('stale_product', `${product.name} changed on another device. Refresh before counting stock.`);
    }
    const unit = await this.requireProductUnit(client, principal.storeId, payload.productId, payload.productUnitId, true);
    const countedBase = payload.inputQuantity === 0 ? 0 : this.convertInputToBase(unit, payload.inputQuantity);
    const delta = countedBase - this.currentBaseStock(product);
    const now = new Date().toISOString();
    await this.updateCanonicalStock(client, principal, product, countedBase, now);
    await this.insertCanonicalMovement(client, principal, {
      product, unit, reason: 'adjustment', inputMode: 'absolute', inputQuantity: payload.inputQuantity,
      baseQuantityDelta: delta, stockAfterBase: countedBase, adjustmentReason: payload.reason,
      note: payload.note || 'Physical stock count', now,
    });
    await this.data.createSyncEvent(client, principal.storeId, 'inventory');
    return { message: 'Physical stock count saved.' };
  }

  private async adjustStockDelta(
    client: { query: DatabaseService['query'] },
    principal: SessionPrincipal,
    payload: Extract<StoreCommand, { type: 'adjustStockDelta' }>['payload'],
  ) {
    const product = await this.requireProductForUpdate(client, principal.storeId, payload.productId);
    const unit = await this.requireProductUnit(client, principal.storeId, payload.productId, payload.productUnitId, true);
    const baseDelta = this.convertInputToBase(unit, Math.abs(payload.inputQuantity)) * Math.sign(payload.inputQuantity);
    const nextBase = this.currentBaseStock(product) + baseDelta;
    if (nextBase < 0) throw new ConflictException(`Only ${this.currentBaseStock(product)} base units of ${product.name} remain.`);
    const now = new Date().toISOString();
    await this.updateCanonicalStock(client, principal, product, nextBase, now);
    await this.insertCanonicalMovement(client, principal, {
      product, unit, reason: 'adjustment', inputMode: 'delta', inputQuantity: Math.abs(payload.inputQuantity),
      baseQuantityDelta: baseDelta, stockAfterBase: nextBase, adjustmentReason: payload.reason,
      note: payload.note || 'Inventory adjustment', now,
    });
    await this.data.createSyncEvent(client, principal.storeId, 'inventory');
    return { message: 'Inventory adjustment saved.' };
  }

  private async requireProductForUpdate(client: { query: DatabaseService['query'] }, storeId: string, productId: string) {
    const result = await client.query<ProductRow>('SELECT * FROM products WHERE id = $1 AND store_id = $2 FOR UPDATE', [productId, storeId]);
    if (!result.rows[0]) throw new StaleConflict('not_found', 'That product could not be found.');
    return result.rows[0];
  }

  private async requireProductUnit(
    client: { query: DatabaseService['query'] },
    storeId: string,
    productId: string,
    unitId: string,
    requireRestock: boolean,
  ) {
    const result = await client.query<ProductUnitRow>(
      'SELECT * FROM product_units WHERE id = $1 AND store_id = $2 AND product_id = $3',
      [unitId, storeId, productId],
    );
    const unit = result.rows[0];
    if (!unit || (requireRestock && !unit.can_restock) || !unit.is_active) {
      throw new ConflictException('The selected inventory unit is no longer available.');
    }
    return unit;
  }

  private currentBaseStock(product: ProductRow) {
    return Number(product.stock_base_quantity ?? Math.round(product.stock_quantity));
  }

  private legacyDisplayMultiplier(product: ProductRow) {
    const unit = product.unit.trim().toLowerCase();
    return unit === 'kg' || unit === 'kilogram' || unit === 'liter' || unit === 'litre' ? 1000 : 1;
  }

  private legacyBaseUnit(unit: string) {
    const normalized = unit.trim().toLowerCase();
    if (normalized === 'kg' || normalized === 'kilogram') return 'g';
    if (normalized === 'liter' || normalized === 'litre') return 'milliliter';
    return unit.trim() || 'piece';
  }

  private convertInputToBase(unit: ProductUnitRow, inputQuantity: number) {
    if (!Number.isFinite(inputQuantity) || inputQuantity <= 0) throw new ConflictException('Quantity must be above zero.');
    const step = Number(unit.quantity_step);
    const ratio = inputQuantity / step;
    if (Math.abs(ratio - Math.round(ratio)) > 0.000001) {
      throw new ConflictException(`Quantity must use increments of ${step} ${unit.name}.`);
    }
    const base = inputQuantity * Number(unit.multiplier_base_units);
    if (!Number.isSafeInteger(Math.round(base))) throw new ConflictException('Quantity is too large.');
    return Math.round(base);
  }

  private async updateCanonicalStock(
    client: { query: DatabaseService['query'] },
    principal: SessionPrincipal,
    product: ProductRow,
    nextBase: number,
    now: string,
  ) {
    await client.query(
      `UPDATE products
          SET stock_base_quantity = $3,
              stock_quantity = $6,
              record_version = record_version + 1,
              updated_at = $4,
              updated_by_user_id = $5
        WHERE id = $1 AND store_id = $2`,
      [product.id, principal.storeId, nextBase, now, principal.userId, this.normalizeQuantity(nextBase / this.legacyDisplayMultiplier(product))],
    );
  }

  private async insertCanonicalMovement(
    client: { query: DatabaseService['query'] },
    principal: SessionPrincipal,
    input: {
      product: ProductRow;
      unit: ProductUnitRow;
      reason: 'restock' | 'adjustment';
      inputMode: 'delta' | 'absolute';
      inputQuantity: number;
      baseQuantityDelta: number;
      stockAfterBase: number;
      adjustmentReason?: string;
      note: string;
      now: string;
    },
  ) {
    await client.query(
      `INSERT INTO inventory_movements
       (id, store_id, product_id, sale_id, reason, quantity_delta, stock_after, note,
        actor_user_id, device_id, record_version, created_at, updated_at,
        product_unit_id, input_mode, input_quantity, input_unit_snapshot,
        multiplier_base_units_snapshot, base_quantity_delta, stock_after_base,
        adjustment_reason, actor_display_name_snapshot)
       VALUES ($1, $2, $3, NULL, $4, $5, $6, $7, $8, $9, 1, $10, $10,
               $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
      [
        crypto.randomUUID(), principal.storeId, input.product.id, input.reason,
        input.baseQuantityDelta, input.stockAfterBase, input.note, principal.userId,
        principal.deviceId, input.now, input.unit.id, input.inputMode, input.inputQuantity,
        input.unit.name, input.unit.multiplier_base_units, input.baseQuantityDelta,
        input.stockAfterBase, input.adjustmentReason ?? null, principal.displayName,
      ],
    );
  }

  private async createCustomer(client: { query: DatabaseService['query'] }, principal: SessionPrincipal, name: string) {
    const normalized = name.trim();
    if (!normalized) throw new ConflictException('Enter a customer name');
    const existing = await client.query<CustomerRow>(
      'SELECT id, record_version, is_active, name FROM customers WHERE store_id = $1 AND LOWER(name) = LOWER($2) ORDER BY created_at ASC LIMIT 1',
      [principal.storeId, normalized],
    );
    if (existing.rows[0]) {
      return { customerId: existing.rows[0].id, message: existing.rows[0].is_active ? 'Customer already exists.' : 'Customer was found but is inactive.' };
    }
    const now = new Date().toISOString();
    const customerId = crypto.randomUUID();
    await client.query(
      `INSERT INTO customers
       (id, store_id, name, nickname, phone_number, notes, is_active, record_version, created_at, updated_at, created_by_user_id, updated_by_user_id)
       VALUES ($1, $2, $3, NULL, NULL, NULL, true, 1, $4, $4, $5, $5)`,
      [customerId, principal.storeId, normalized, now, principal.userId],
    );
    await this.data.createSyncEvent(client, principal.storeId, 'customer');
    return { customerId, message: 'Customer created.' };
  }

  private async recordUtangPayment(client: { query: DatabaseService['query'] }, principal: SessionPrincipal, customerId: string, amount: number, note: string) {
    const customer = await client.query<CustomerRow>(
      'SELECT id, record_version, is_active, name FROM customers WHERE id = $1 AND store_id = $2',
      [customerId, principal.storeId],
    );
    if (!customer.rows[0]?.is_active) throw new StaleConflict('stale_customer', 'The selected customer is no longer active.');
    const now = new Date().toISOString();
    await client.query(
      `INSERT INTO utang_entries
       (id, store_id, customer_id, sale_id, kind, amount, note, actor_user_id, record_version, created_at, updated_at)
       VALUES ($1, $2, $3, NULL, 'payment', $4, $5, $6, 1, $7, $7)`,
      [crypto.randomUUID(), principal.storeId, customerId, amount, note || 'Payment received', principal.userId, now],
    );
    await this.data.createSyncEvent(client, principal.storeId, 'utang_payment');
    return { message: 'Payment recorded.' };
  }

  private async recordExpense(client: { query: DatabaseService['query'] }, principal: SessionPrincipal, category: string, description: string, amount: number, occurredAt: string) {
    const now = new Date().toISOString();
    const expenseId = crypto.randomUUID();
    await client.query(
      `INSERT INTO expenses
       (id, store_id, category, description, amount, occurred_at, actor_user_id, record_version, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8, $8)`,
      [expenseId, principal.storeId, category.trim(), description.trim(), amount, occurredAt, principal.userId, now],
    );
    await this.data.createSyncEvent(client, principal.storeId, 'expense');
    return { expenseId, message: 'Expense saved.' };
  }

  private async requireProduct(client: { query: DatabaseService['query'] }, storeId: string, productId: string) {
    const result = await client.query<ProductRow>('SELECT * FROM products WHERE id = $1 AND store_id = $2', [productId, storeId]);
    if (!result.rows[0]) throw new StaleConflict('not_found', 'That product could not be found.');
    return result.rows[0];
  }

  private prepareCanonicalSaleLine(
    product: ProductRow,
    unit: ProductUnitRow,
    line: Extract<Extract<StoreCommand, { type: 'completeSale' }>['payload']['cart'][number], object>,
  ) {
    if (!unit.can_sell || unit.selling_price == null || unit.selling_price < 0) {
      throw new ConflictException(`${product.name} cannot be sold using ${unit.name}`);
    }
    const pricingMode = line.pricingMode ?? 'quantity';
    let inputQuantity = line.inputQuantity ?? line.quantity;
    let baseQuantity: number;
    let subtotal: number;
    if (pricingMode === 'amount') {
      if (!unit.allow_amount_pricing) throw new ConflictException(`${unit.name} cannot be sold by amount`);
      const amount = line.enteredAmount ?? 0;
      const increment = this.baseIncrement(unit);
      const theoreticalBase = (amount / unit.selling_price) * Number(unit.multiplier_base_units);
      baseQuantity = Math.floor(theoreticalBase / increment + 0.5) * increment;
      if (!Number.isInteger(amount) || amount <= 0 || baseQuantity <= 0) throw new ConflictException('Peso amount is below the minimum sale increment');
      inputQuantity = this.normalizeQuantity(baseQuantity / Number(unit.multiplier_base_units));
      subtotal = amount;
    } else {
      baseQuantity = this.convertInputToBase(unit, inputQuantity);
      subtotal = Math.round(inputQuantity * unit.selling_price);
    }
    return {
      product,
      unit,
      quantity: inputQuantity,
      inputQuantity,
      baseQuantity,
      subtotal,
    };
  }

  private prepareSaleLine(product: ProductRow, line: Extract<Extract<StoreCommand, { type: 'completeSale' }>['payload']['cart'][number], object>) {
    const pricingMode = line.pricingMode ?? 'quantity';
    if (pricingMode === 'amount') {
      const enteredAmount = line.enteredAmount ?? 0;
      if (!product.sold_by_weight) throw new ConflictException(`${product.name} cannot be sold by amount`);
      if (product.selling_price <= 0) throw new ConflictException(`${product.name} needs a selling price before it can be sold by amount`);
      const maximumAmount = Math.floor(product.stock_quantity * product.selling_price);
      if (!Number.isInteger(enteredAmount) || enteredAmount <= 0 || enteredAmount > maximumAmount) {
        throw new ConflictException(`Only ${product.stock_quantity} ${product.unit} of ${product.name} remain`);
      }
      const quantity = this.normalizeQuantity(enteredAmount / product.selling_price);
      const baseQuantity = Math.round(quantity * this.legacyDisplayMultiplier(product));
      return { product, quantity, inputQuantity: quantity, baseQuantity, unit: undefined, subtotal: enteredAmount };
    }
    const quantity = line.quantity;
    if (!Number.isFinite(quantity) || quantity <= 0) throw new ConflictException(`Enter a valid quantity for ${product.name}`);
    const step = product.sold_by_weight ? product.quantity_step : 1;
    if (!this.isStepAligned(quantity, step)) {
      throw new ConflictException(`${product.name} must be sold in increments of ${step} ${product.unit}`);
    }
    const baseQuantity = Math.round(quantity * this.legacyDisplayMultiplier(product));
    return { product, quantity, inputQuantity: quantity, baseQuantity, unit: undefined, subtotal: Math.round(quantity * product.selling_price) };
  }

  private baseIncrement(unit: ProductUnitRow) {
    const increment = Number(unit.multiplier_base_units) * Number(unit.quantity_step);
    if (!Number.isSafeInteger(Math.round(increment)) || Math.abs(increment - Math.round(increment)) > 0.000001) {
      throw new ConflictException(`Unit ${unit.name} is not aligned to base units`);
    }
    return Math.round(increment);
  }

  private validateStockQuantity(soldByWeight: boolean, quantityStep: number, quantity: number, unit: string) {
    const step = soldByWeight ? quantityStep : 1;
    if (!Number.isFinite(quantity) || quantity < 0 || !this.isStepAligned(quantity, step)) {
      throw new ConflictException(soldByWeight
        ? `Stock must use increments of ${step} ${unit}`
        : 'Regular products require a whole-number stock quantity');
    }
  }

  private isStepAligned(quantity: number, step: number) {
    const units = quantity / step;
    return Math.abs(units - Math.round(units)) < 0.000001;
  }

  private normalizeQuantity(value: number) {
    return Math.round(value * 1_000_000) / 1_000_000;
  }

  private calculateChange(total: number, cashReceived: number) {
    if (cashReceived < total) return null;
    return cashReceived - total;
  }

  private normalizeQrReference(reference: string) {
    return reference.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 80);
  }

  private async resolveCommandActor(submitter: SessionPrincipal, request: StoreCommandRequest) {
    if (!request.actorProof || !this.auth) return submitter;
    const actor = await this.auth.verify(request.actorProof);
    if (actor.storeId !== submitter.storeId || actor.deviceId !== submitter.deviceId) {
      throw new ForbiddenException('The offline action proof does not match this store device');
    }
    return actor;
  }

  private async recordCommandActivity(
    client: { query: DatabaseService['query'] },
    actor: SessionPrincipal,
    submitter: SessionPrincipal,
    request: StoreCommandRequest,
    result: Record<string, unknown>,
  ) {
    if (!this.activity) return;
    const command = request.command;
    let category: Parameters<ActivityService['record']>[1]['category'];
    let action: string;
    let entityType: string | null = null;
    let entityId: string | null = null;
    let summary: string;
    let details: Record<string, unknown> = {};

    switch (command.type) {
      case 'saveProduct': {
        category = 'products';
        action = command.payload.id ? 'product.updated' : 'product.created';
        entityType = 'product';
        entityId = typeof result.productId === 'string' ? result.productId : command.payload.id ?? null;
        summary = `${command.payload.id ? 'Updated' : 'Created'} product ${command.payload.name}`;
        details = {
          after: {
            name: command.payload.name,
            category: command.payload.category,
            barcode: command.payload.barcode ?? null,
            costPrice: command.payload.costPrice,
            sellingPrice: command.payload.sellingPrice,
            stockQuantity: command.payload.stockQuantity,
            unit: command.payload.unit,
            isActive: command.payload.isActive,
          },
        };
        break;
      }
      case 'completeSale': {
        const sale = await client.query<{ total: number }>(
          'SELECT total FROM sales WHERE id = $1 AND store_id = $2',
          [command.payload.saleId, actor.storeId],
        );
        const total = sale.rows[0]?.total ?? null;
        category = 'sales';
        action = 'sale.completed';
        entityType = 'sale';
        entityId = command.payload.saleId;
        summary = `Completed sale ${command.payload.transactionNumber}${total == null ? '' : ` for ${this.formatMoney(total)}`}`;
        details = {
          transactionNumber: command.payload.transactionNumber,
          total,
          paymentMethod: command.payload.paymentMethod,
          customerId: command.payload.customerId,
          itemCount: command.payload.cart.length,
          utangPurchase: command.payload.paymentMethod === 'utang',
        };
        break;
      }
      case 'reviewQrPayment': {
        category = 'sales';
        action = command.payload.decision === 'verify' ? 'payment.qrph_verified' : 'payment.qrph_rejected';
        entityType = 'qr_payment';
        entityId = command.payload.paymentId;
        summary = command.payload.decision === 'verify' ? 'Verified a QR Ph payment' : 'Marked a QR Ph payment unpaid';
        details = { decision: command.payload.decision, note: command.payload.note };
        break;
      }
      case 'adjustStock':
        category = 'inventory'; action = 'inventory.adjusted'; entityType = 'product'; entityId = command.payload.productId;
        summary = `Adjusted stock for ${await this.productName(client, actor.storeId, command.payload.productId)}`;
        details = { newQuantity: command.payload.newQuantity, note: command.payload.note };
        break;
      case 'restockProduct':
        category = 'inventory'; action = 'inventory.restocked'; entityType = 'product'; entityId = command.payload.productId;
        summary = `Restocked ${await this.productName(client, actor.storeId, command.payload.productId)}`;
        details = { mode: command.payload.mode, quantity: command.payload.quantity, note: command.payload.note };
        break;
      case 'receiveStock':
        category = 'inventory'; action = 'inventory.restocked'; entityType = 'product'; entityId = command.payload.productId;
        summary = `Received stock for ${await this.productName(client, actor.storeId, command.payload.productId)}`;
        details = { productUnitId: command.payload.productUnitId, inputQuantity: command.payload.inputQuantity, note: command.payload.note };
        break;
      case 'countStock':
        category = 'inventory'; action = 'inventory.counted'; entityType = 'product'; entityId = command.payload.productId;
        summary = `Counted stock for ${await this.productName(client, actor.storeId, command.payload.productId)}`;
        details = { productUnitId: command.payload.productUnitId, inputQuantity: command.payload.inputQuantity, reason: command.payload.reason, note: command.payload.note };
        break;
      case 'adjustStockDelta':
        category = 'inventory'; action = 'inventory.adjusted'; entityType = 'product'; entityId = command.payload.productId;
        summary = `Adjusted stock for ${await this.productName(client, actor.storeId, command.payload.productId)}`;
        details = { productUnitId: command.payload.productUnitId, inputQuantity: command.payload.inputQuantity, reason: command.payload.reason, note: command.payload.note };
        break;
      case 'createCustomer':
        category = 'customers';
        action = result.message === 'Customer created.' ? 'customer.created' : 'customer.reused';
        entityType = 'customer';
        entityId = typeof result.customerId === 'string' ? result.customerId : null;
        summary = `${action === 'customer.created' ? 'Created' : 'Selected existing'} customer ${command.payload.name}`;
        details = { name: command.payload.name };
        break;
      case 'recordUtangPayment': {
        const customer = await client.query<{ name: string }>('SELECT name FROM customers WHERE id = $1 AND store_id = $2', [command.payload.customerId, actor.storeId]);
        category = 'utang'; action = 'utang.payment_recorded'; entityType = 'customer'; entityId = command.payload.customerId;
        summary = `Recorded ${this.formatMoney(command.payload.amount)} utang payment for ${customer.rows[0]?.name ?? 'customer'}`;
        details = { amount: command.payload.amount, note: command.payload.note };
        break;
      }
      case 'recordExpense':
        category = 'expenses'; action = 'expense.recorded'; entityType = 'expense';
        entityId = typeof result.expenseId === 'string' ? result.expenseId : null;
        summary = `Recorded ${this.formatMoney(command.payload.amount)} expense for ${command.payload.description}`;
        details = { category: command.payload.category, description: command.payload.description, amount: command.payload.amount, occurredAt: command.payload.occurredAt };
        break;
    }

    await this.activity.record(client, {
      storeId: actor.storeId,
      actor,
      submittedBy: submitter,
      category,
      action,
      entityType,
      entityId,
      summary,
      details,
      clientCommandId: request.clientCommandId,
      occurredAt: request.occurredAt ?? ('occurredAt' in command.payload ? command.payload.occurredAt : undefined),
    });
  }

  private async productName(client: { query: DatabaseService['query'] }, storeId: string, productId: string) {
    const product = await client.query<{ name: string }>('SELECT name FROM products WHERE id = $1 AND store_id = $2', [productId, storeId]);
    return product.rows[0]?.name ?? 'product';
  }

  private formatMoney(value: number) {
    return `₱${(value / 100).toFixed(2)}`;
  }

  private requireRole(principal: SessionPrincipal, roles: SessionPrincipal['role'][]) {
    if (!roles.includes(principal.role)) throw new ForbiddenException('You do not have access to this action');
  }

  private async conflict(
    storeId: string,
    reason: CommandConflictReason,
    message: string,
    includeSnapshot = true,
  ): Promise<StoreCommandResponse> {
    const cursor = await this.data.currentCursor(storeId);
    const snapshot = includeSnapshot ? await this.data.loadBrowserSnapshot(storeId) : undefined;
    return { status: 'conflict', reason, cursor, message, ...(snapshot ? { snapshot } : {}) };
  }
}

class StaleConflict extends Error {
  constructor(
    readonly reason: CommandConflictReason,
    message: string,
  ) {
    super(message);
  }
}
