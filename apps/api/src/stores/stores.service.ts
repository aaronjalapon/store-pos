import { ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import type { StoreBootstrapResponse, StoreSnapshot, StoreSyncResponse } from '@gma/contracts';
import { DatabaseService } from '../database/database.service';
import { AuthService } from '../auth/auth.service';
import type { SessionPrincipal } from '../auth/auth.types';
import { StoreDataService } from './store-data.service';

@Injectable()
export class StoresService {
  constructor(
    private readonly auth: AuthService,
    private readonly data: StoreDataService,
    private readonly database: DatabaseService,
  ) {}

  async bootstrap(principal: SessionPrincipal, token: string): Promise<StoreBootstrapResponse> {
    await this.auth.markDeviceSynced(principal.storeId, principal.deviceId);
    const [session, snapshot, cursor] = await Promise.all([
      this.auth.buildSession(principal, token),
      this.data.loadSnapshot(principal.storeId),
      this.data.currentCursor(principal.storeId),
    ]);
    return { session, snapshot, cursor };
  }

  async sync(principal: SessionPrincipal): Promise<StoreSyncResponse> {
    await this.auth.touchDevice(principal.storeId, principal.deviceId);
    const [snapshot, cursor] = await Promise.all([
      this.data.loadSnapshot(principal.storeId),
      this.data.currentCursor(principal.storeId),
    ]);
    return { snapshot, cursor };
  }

  async importLegacy(principal: SessionPrincipal, snapshot: StoreSnapshot) {
    if (!['owner', 'admin'].includes(principal.role)) throw new ForbiddenException('Only owner or admin can import store data');
    const empty = await this.data.isStoreEmpty(principal.storeId);
    if (!empty) throw new ConflictException('This store already has live data and can no longer import a legacy snapshot');
    await this.database.transaction(async (client) => {
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
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $18)`,
          [unit.id, principal.storeId, unit.productId, unit.name, unit.symbol, unit.multiplierBaseUnits, unit.quantityStep,
            unit.canSell, unit.canRestock, unit.allowAmountPricing, unit.sellingPrice, unit.costPrice, unit.barcode,
            unit.isBase, unit.isActive, unit.replacesUnitId, unit.recordVersion, unit.createdAt],
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
          [sale.id, principal.storeId, sale.transactionNumber, sale.customerId, principal.userId, principal.deviceId, sale.subtotal, sale.discount, sale.total, sale.paymentMethod, sale.cashReceived, sale.changeAmount, sale.recordVersion, sale.createdAt, sale.updatedAt],
        );
      }
      for (const item of snapshot.saleItems) {
        await client.query(
          `INSERT INTO sale_items
           (id, store_id, sale_id, product_id, product_name_snapshot, quantity, unit_price, cost_price_snapshot, subtotal, record_version, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [item.id, principal.storeId, item.saleId, item.productId, item.productNameSnapshot, item.quantity, item.unitPrice, item.costPriceSnapshot, item.subtotal, item.recordVersion, item.createdAt, item.updatedAt],
        );
      }
      for (const movement of snapshot.inventoryMovements) {
        await client.query(
          `INSERT INTO inventory_movements
           (id, store_id, product_id, sale_id, reason, quantity_delta, stock_after, note, actor_user_id, device_id, record_version, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
          [movement.id, principal.storeId, movement.productId, movement.saleId, movement.reason, movement.quantityDelta, movement.stockAfter, movement.note, principal.userId, principal.deviceId, movement.recordVersion, movement.createdAt, movement.updatedAt],
        );
      }
      for (const entry of snapshot.utangEntries) {
        await client.query(
          `INSERT INTO utang_entries
           (id, store_id, customer_id, sale_id, kind, amount, note, actor_user_id, record_version, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [entry.id, principal.storeId, entry.customerId, entry.saleId, entry.kind, entry.amount, entry.note, principal.userId, entry.recordVersion, entry.createdAt, entry.updatedAt],
        );
      }
      for (const expense of snapshot.expenses) {
        await client.query(
          `INSERT INTO expenses
           (id, store_id, category, description, amount, occurred_at, actor_user_id, record_version, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [expense.id, principal.storeId, expense.category, expense.description, expense.amount, expense.occurredAt, principal.userId, expense.recordVersion, expense.createdAt, expense.updatedAt],
        );
      }
      await this.data.createSyncEvent(client, principal.storeId, 'legacy_import');
    });
    return this.sync(principal);
  }
}
