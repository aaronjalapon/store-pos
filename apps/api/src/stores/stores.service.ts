import { BadRequestException, ConflictException, ForbiddenException, Injectable, Optional } from '@nestjs/common';
import type { StoreBootstrapResponse, StoreDeltaSyncResponse, StoreSnapshot, StoreSyncResponse } from '@gma/contracts';
import { DatabaseService } from '../database/database.service';
import { AuthService } from '../auth/auth.service';
import type { SessionPrincipal } from '../auth/auth.types';
import { StoreDataService } from './store-data.service';
import { ActivityService } from '../activity/activity.service';

@Injectable()
export class StoresService {
  constructor(
    private readonly auth: AuthService,
    private readonly data: StoreDataService,
    private readonly database: DatabaseService,
    @Optional() private readonly activity?: ActivityService,
  ) {}

  async bootstrap(principal: SessionPrincipal, token: string): Promise<StoreBootstrapResponse> {
    await this.auth.markDeviceSynced(principal.storeId, principal.deviceId);
    const [session, state] = await Promise.all([
      this.auth.buildSession(principal, token),
      this.data.loadSyncSnapshot(principal.storeId, true),
    ]);
    return { session, ...state };
  }

  async sync(principal: SessionPrincipal): Promise<StoreSyncResponse> {
    await this.auth.touchDevice(principal.storeId, principal.deviceId);
    return this.data.loadSyncSnapshot(principal.storeId);
  }

  async syncV2(principal: SessionPrincipal, cursor: number): Promise<StoreDeltaSyncResponse> {
    await this.auth.touchDevice(principal.storeId, principal.deviceId);
    const delta = await this.data.loadDelta(principal.storeId, cursor);
    if (delta.fullResyncRequired) {
      throw new ConflictException({
        code: 'full_resync_required',
        message: 'This device is older than the retained sync window and must reload store data.',
      });
    }
    const historyWindowStart = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    if (!delta.changes.length && !delta.tombstones.length) return { ...delta, historyWindowStart };
    const entityTypes = [...delta.changes, ...delta.tombstones].map((change) => change.entityType);
    return { ...delta, historyWindowStart, patch: await this.data.loadDeltaPatch(principal.storeId, entityTypes) };
  }

  async importLegacy(principal: SessionPrincipal, snapshot: StoreSnapshot) {
    if (!['owner', 'admin'].includes(principal.role)) throw new ForbiddenException('Only owner or admin can import store data');
    if (snapshot.paymentSettings || snapshot.products.some((product) => product.imageRevision)) {
      throw new BadRequestException('Legacy imports cannot contain image metadata without the corresponding image objects');
    }
    const empty = await this.data.isStoreEmpty(principal.storeId);
    if (!empty) throw new ConflictException('This store already has live data and can no longer import a legacy snapshot');
    await this.database.transaction((client) => this.insertSnapshot(client, principal, snapshot));
    return this.sync(principal);
  }

  async insertSnapshot(
    client: { query: DatabaseService['query'] },
    principal: SessionPrincipal,
    snapshot: StoreSnapshot,
    options: { preserveActors?: boolean } = {},
  ) {
      for (const product of snapshot.products) {
        await client.query(
          `INSERT INTO products
           (id, store_id, barcode, sku, image_revision, name, category, cost_price, selling_price,
            stock_quantity, unit, sold_by_weight, quantity_step, low_stock_threshold, is_quick_item,
            is_active, record_version, created_at, updated_at, created_by_user_id, updated_by_user_id,
            base_unit, stock_base_quantity, low_stock_base_threshold, default_sale_unit_id, default_restock_unit_id, display_unit_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $20,
                   $21, $22, $23, $24, $25, $26)`,
          [
            product.id, principal.storeId, product.barcode, product.sku, product.imageRevision, product.name, product.category,
            product.costPrice, product.sellingPrice, product.stockQuantity, product.unit, product.soldByWeight, product.quantityStep,
            product.lowStockThreshold, product.isQuickItem, product.isActive, product.recordVersion, product.createdAt,
            product.updatedAt, principal.userId, product.baseUnit ?? product.unit, product.stockBaseQuantity ?? Math.round(product.stockQuantity),
            product.lowStockBaseThreshold ?? Math.round(product.lowStockThreshold), null, null, null,
          ],
        );
      }
      for (const unit of snapshot.productUnits ?? []) {
        await client.query(
          `INSERT INTO product_units
           (id, store_id, product_id, name, symbol, multiplier_base_units, quantity_step, can_sell, can_restock,
            allow_amount_pricing, selling_price, cost_price, barcode, is_base, is_active, replaces_unit_id,
            record_version, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
          [unit.id, principal.storeId, unit.productId, unit.name, unit.symbol, unit.multiplierBaseUnits, unit.quantityStep,
            unit.canSell, unit.canRestock, unit.allowAmountPricing, unit.sellingPrice, unit.costPrice, unit.barcode,
            unit.isBase, unit.isActive, null, unit.recordVersion, unit.createdAt, unit.updatedAt],
        );
      }
      // Replacements can reference a unit that appears later in the snapshot.
      for (const unit of snapshot.productUnits ?? []) {
        if (unit.replacesUnitId) await client.query(
          'UPDATE product_units SET replaces_unit_id = $3 WHERE id = $1 AND store_id = $2',
          [unit.id, principal.storeId, unit.replacesUnitId],
        );
      }
      for (const product of snapshot.products) {
        if (!product.baseUnitId && !product.defaultSaleUnitId && !product.defaultRestockUnitId && !product.displayUnitId) continue;
        await client.query(
          `UPDATE products SET base_unit_id = $3, default_sale_unit_id = $4, default_restock_unit_id = $5, display_unit_id = $6
           WHERE id = $1 AND store_id = $2`,
          [product.id, principal.storeId, product.baseUnitId ?? null, product.defaultSaleUnitId ?? null,
            product.defaultRestockUnitId ?? null, product.displayUnitId ?? null],
        );
      }
      for (const customer of snapshot.customers) {
        await client.query(
          `INSERT INTO customers
           (id, store_id, name, nickname, phone_number, notes, is_active, record_version, created_at, updated_at, created_by_user_id, updated_by_user_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)`,
          [customer.id, principal.storeId, customer.name, customer.nickname, customer.phoneNumber, customer.notes, customer.isActive, customer.recordVersion, customer.createdAt, customer.updatedAt, principal.userId],
        );
      }
      for (const sale of snapshot.sales) {
        await client.query(
          `INSERT INTO sales
           (id, store_id, transaction_number, customer_id, cashier_user_id, device_id, subtotal, discount, total,
            payment_method, cash_received, change_amount, record_version, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
          [sale.id, principal.storeId, sale.transactionNumber, sale.customerId, options.preserveActors ? sale.cashierUserId : principal.userId, options.preserveActors ? sale.deviceId : principal.deviceId, sale.subtotal, sale.discount, sale.total, sale.paymentMethod, sale.cashReceived, sale.changeAmount, sale.recordVersion, sale.createdAt, sale.updatedAt],
        );
      }
      for (const payment of snapshot.qrPayments ?? []) {
        await client.query(
          `INSERT INTO qr_payments
           (id, store_id, sale_id, cashier_user_id, cashier_display_name_snapshot, device_id, amount, reference, normalized_reference,
            confirmation_source, status, attention_reason, confirmed_at, reviewed_at, reviewed_by_user_id,
            review_note, record_version, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
          [payment.id, principal.storeId, payment.saleId, options.preserveActors ? payment.cashierUserId : principal.userId, payment.cashierDisplayNameSnapshot, options.preserveActors ? payment.deviceId : principal.deviceId, payment.amount,
            payment.reference, payment.normalizedReference, payment.confirmationSource, payment.status,
            payment.attentionReason, payment.confirmedAt, payment.reviewedAt, payment.reviewedByUserId ? (options.preserveActors ? payment.reviewedByUserId : principal.userId) : null,
            payment.reviewNote, payment.recordVersion, payment.createdAt, payment.updatedAt],
        );
      }
      await client.query(
        `INSERT INTO qr_reference_claims (store_id, normalized_reference, first_qr_payment_id, created_at)
         SELECT DISTINCT ON (store_id, normalized_reference)
                store_id, normalized_reference, id, created_at
           FROM qr_payments WHERE store_id = $1
          ORDER BY store_id, normalized_reference, created_at, id
         ON CONFLICT DO NOTHING`,
        [principal.storeId],
      );
      for (const item of snapshot.saleItems) {
        await client.query(
          `INSERT INTO sale_items
           (id, store_id, sale_id, product_id, product_name_snapshot, quantity, unit_price, cost_price_snapshot, subtotal, record_version, created_at, updated_at,
            product_unit_id, input_quantity, unit_name_snapshot, unit_symbol_snapshot, multiplier_base_units_snapshot, base_quantity)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
          [item.id, principal.storeId, item.saleId, item.productId, item.productNameSnapshot, item.quantity, item.unitPrice, item.costPriceSnapshot, item.subtotal, item.recordVersion, item.createdAt, item.updatedAt,
            item.productUnitId ?? null, item.inputQuantity ?? null, item.unitNameSnapshot ?? null,
            item.unitSymbolSnapshot ?? null, item.multiplierBaseUnitsSnapshot ?? null, item.baseQuantity ?? null],
        );
      }
      for (const movement of snapshot.inventoryMovements) {
        await client.query(
          `INSERT INTO inventory_movements
           (id, store_id, product_id, sale_id, reason, quantity_delta, stock_after, note, actor_user_id, device_id, record_version, created_at, updated_at,
            product_unit_id, input_mode, input_quantity, input_unit_snapshot, multiplier_base_units_snapshot,
            base_quantity_delta, stock_after_base, adjustment_reason, actor_display_name_snapshot)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)`,
          [movement.id, principal.storeId, movement.productId, movement.saleId, movement.reason, movement.quantityDelta, movement.stockAfter, movement.note, options.preserveActors ? movement.actorUserId : principal.userId, options.preserveActors ? movement.deviceId : principal.deviceId, movement.recordVersion, movement.createdAt, movement.updatedAt,
            movement.productUnitId ?? null, movement.inputMode ?? 'delta', movement.inputQuantity ?? null,
            movement.inputUnitSnapshot ?? null, movement.multiplierBaseUnitsSnapshot ?? null,
            movement.baseQuantityDelta ?? null, movement.stockAfterBase ?? null, movement.adjustmentReason ?? null,
            movement.actorDisplayNameSnapshot ?? null],
        );
      }
      for (const entry of snapshot.utangEntries) {
        await client.query(
          `INSERT INTO utang_entries
           (id, store_id, customer_id, sale_id, kind, amount, note, actor_user_id, record_version, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [entry.id, principal.storeId, entry.customerId, entry.saleId, entry.kind, entry.amount, entry.note, options.preserveActors ? entry.actorUserId : principal.userId, entry.recordVersion, entry.createdAt, entry.updatedAt],
        );
      }
      for (const expense of snapshot.expenses) {
        await client.query(
          `INSERT INTO expenses
           (id, store_id, category, description, amount, occurred_at, actor_user_id, record_version, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [expense.id, principal.storeId, expense.category, expense.description, expense.amount, expense.occurredAt, options.preserveActors ? expense.actorUserId : principal.userId, expense.recordVersion, expense.createdAt, expense.updatedAt],
        );
      }
      await this.data.createSyncEvent(client, principal.storeId, 'legacy_import');
      await this.activity?.record(client, {
        storeId: principal.storeId,
        actor: principal,
        category: 'data',
        action: 'data.legacy_imported',
        entityType: 'store',
        entityId: principal.storeId,
        summary: 'Imported legacy store data',
        details: {
          products: snapshot.products.length,
          sales: snapshot.sales.length,
          customers: snapshot.customers.length,
          expenses: snapshot.expenses.length,
        },
      });
  }

  async clearOperationalData(
    client: { query: DatabaseService['query'] },
    storeId: string,
    retainedObjectKeys: string[] = [],
  ) {
    // Preserve audit history and the idempotency window across a restore so delayed
    // devices cannot replay commands that were already accepted before recovery.
    await client.query('DELETE FROM qr_reference_claims WHERE store_id = $1', [storeId]);
    await client.query('DELETE FROM qr_payments WHERE store_id = $1', [storeId]);
    await client.query('DELETE FROM utang_entries WHERE store_id = $1', [storeId]);
    await client.query('DELETE FROM inventory_movements WHERE store_id = $1', [storeId]);
    await client.query('DELETE FROM sale_items WHERE store_id = $1', [storeId]);
    await client.query('DELETE FROM sales WHERE store_id = $1', [storeId]);
    await client.query('DELETE FROM expenses WHERE store_id = $1', [storeId]);
    await client.query(
      `INSERT INTO object_operations (id, store_id, operation, object_kind, final_key)
       SELECT gen_random_uuid(), store_id, 'delete', 'qrph_image', object_key
         FROM qrph_payment_settings
        WHERE store_id = $1 AND NOT (object_key = ANY($2::text[]))`,
      [storeId, retainedObjectKeys],
    );
    await client.query('DELETE FROM qrph_payment_settings WHERE store_id = $1', [storeId]);
    await client.query(
      `INSERT INTO object_operations (id, store_id, operation, object_kind, final_key)
       SELECT gen_random_uuid(), store_id, 'delete', 'product_image', object_key
         FROM product_images
        WHERE store_id = $1 AND NOT (object_key = ANY($2::text[]))`,
      [storeId, retainedObjectKeys],
    );
    await client.query('DELETE FROM product_images WHERE store_id = $1', [storeId]);
    await client.query(
      `UPDATE products SET base_unit_id = NULL, default_sale_unit_id = NULL,
        default_restock_unit_id = NULL, display_unit_id = NULL WHERE store_id = $1`,
      [storeId],
    );
    await client.query('DELETE FROM product_units WHERE store_id = $1', [storeId]);
    await client.query('DELETE FROM products WHERE store_id = $1', [storeId]);
    await client.query('DELETE FROM customers WHERE store_id = $1', [storeId]);
    await client.query('DELETE FROM sync_events WHERE store_id = $1', [storeId]);
  }
}
