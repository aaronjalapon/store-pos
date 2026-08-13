import { Injectable } from '@nestjs/common';
import type {
  Customer,
  Expense,
  InventoryMovement,
  Product,
  Sale,
  SaleItem,
  StaffMember,
  StoreSnapshot,
  UtangEntry,
} from '@gma/contracts';
import { DatabaseService } from '../database/database.service';

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
}

interface SaleRow {
  id: string;
  store_id: string;
  transaction_number: string;
  customer_id: string | null;
  cashier_user_id: string;
  device_id: string;
  subtotal: number;
  discount: number;
  total: number;
  payment_method: Sale['paymentMethod'];
  cash_received: number | null;
  change_amount: number | null;
  record_version: number;
  created_at: Date;
  updated_at: Date;
}

interface SaleItemRow {
  id: string;
  store_id: string;
  sale_id: string;
  product_id: string;
  product_name_snapshot: string;
  quantity: number;
  unit_price: number;
  cost_price_snapshot: number;
  subtotal: number;
  record_version: number;
  created_at: Date;
  updated_at: Date;
}

interface CustomerRow {
  id: string;
  store_id: string;
  name: string;
  nickname: string | null;
  phone_number: string | null;
  notes: string | null;
  is_active: boolean;
  record_version: number;
  created_at: Date;
  updated_at: Date;
}

interface InventoryMovementRow {
  id: string;
  store_id: string;
  product_id: string;
  sale_id: string | null;
  reason: InventoryMovement['reason'];
  quantity_delta: number;
  stock_after: number;
  note: string | null;
  actor_user_id: string;
  device_id: string;
  record_version: number;
  created_at: Date;
  updated_at: Date;
}

interface UtangEntryRow {
  id: string;
  store_id: string;
  customer_id: string;
  sale_id: string | null;
  kind: UtangEntry['kind'];
  amount: number;
  note: string | null;
  actor_user_id: string;
  record_version: number;
  created_at: Date;
  updated_at: Date;
}

interface ExpenseRow {
  id: string;
  store_id: string;
  category: string;
  description: string;
  amount: number;
  occurred_at: Date;
  actor_user_id: string;
  record_version: number;
  created_at: Date;
  updated_at: Date;
}

interface StaffRow {
  id: string;
  display_name: string;
  email: string | null;
  staff_code: string | null;
  role: StaffMember['role'];
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

@Injectable()
export class StoreDataService {
  constructor(private readonly database: DatabaseService) {}

  async loadSnapshot(storeId: string): Promise<StoreSnapshot> {
    const [products, sales, saleItems, inventoryMovements, customers, utangEntries, expenses, staff] = await Promise.all([
      this.database.query<ProductRow>('SELECT * FROM products WHERE store_id = $1 ORDER BY updated_at ASC, id ASC', [storeId]),
      this.database.query<SaleRow>('SELECT * FROM sales WHERE store_id = $1 ORDER BY created_at ASC, id ASC', [storeId]),
      this.database.query<SaleItemRow>('SELECT * FROM sale_items WHERE store_id = $1 ORDER BY created_at ASC, id ASC', [storeId]),
      this.database.query<InventoryMovementRow>('SELECT * FROM inventory_movements WHERE store_id = $1 ORDER BY created_at ASC, id ASC', [storeId]),
      this.database.query<CustomerRow>('SELECT * FROM customers WHERE store_id = $1 ORDER BY updated_at ASC, id ASC', [storeId]),
      this.database.query<UtangEntryRow>('SELECT * FROM utang_entries WHERE store_id = $1 ORDER BY created_at ASC, id ASC', [storeId]),
      this.database.query<ExpenseRow>('SELECT * FROM expenses WHERE store_id = $1 ORDER BY occurred_at ASC, id ASC', [storeId]),
      this.database.query<StaffRow>(
        `SELECT users.id, users.display_name, users.email, users.staff_code,
                store_memberships.role, (users.is_active AND store_memberships.is_active) AS is_active,
                users.created_at, users.updated_at
           FROM users
           JOIN store_memberships ON store_memberships.user_id = users.id
          WHERE store_memberships.store_id = $1
          ORDER BY CASE store_memberships.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, users.display_name ASC`,
        [storeId],
      ),
    ]);

    return {
      products: products.rows.map((row) => this.mapProduct(row)),
      sales: sales.rows.map((row) => this.mapSale(row)),
      saleItems: saleItems.rows.map((row) => this.mapSaleItem(row)),
      inventoryMovements: inventoryMovements.rows.map((row) => this.mapInventoryMovement(row)),
      customers: customers.rows.map((row) => this.mapCustomer(row)),
      utangEntries: utangEntries.rows.map((row) => this.mapUtangEntry(row)),
      expenses: expenses.rows.map((row) => this.mapExpense(row)),
      staff: staff.rows.map((row) => this.mapStaff(row)),
    };
  }

  async currentCursor(storeId: string) {
    const result = await this.database.query<{ cursor: string }>(
      'SELECT COALESCE(MAX(id), 0)::text AS cursor FROM sync_events WHERE store_id = $1',
      [storeId],
    );
    return Number(result.rows[0]?.cursor ?? '0');
  }

  async createSyncEvent(client: { query: DatabaseService['query'] }, storeId: string, kind: string) {
    await client.query('INSERT INTO sync_events (store_id, kind) VALUES ($1, $2)', [storeId, kind]);
  }

  async isStoreEmpty(storeId: string) {
    const result = await this.database.query<{ count: string }>(
      `SELECT (
         (SELECT COUNT(*) FROM products WHERE store_id = $1) +
         (SELECT COUNT(*) FROM sales WHERE store_id = $1) +
         (SELECT COUNT(*) FROM customers WHERE store_id = $1) +
         (SELECT COUNT(*) FROM expenses WHERE store_id = $1)
       )::text AS count`,
      [storeId],
    );
    return Number(result.rows[0]?.count ?? '0') === 0;
  }

  private mapProduct(row: ProductRow): Product {
    return {
      id: row.id,
      storeId: row.store_id,
      barcode: row.barcode,
      sku: row.sku,
      imageRevision: row.image_revision,
      name: row.name,
      category: row.category,
      costPrice: row.cost_price,
      sellingPrice: row.selling_price,
      stockQuantity: Number(row.stock_quantity),
      unit: row.unit,
      soldByWeight: row.sold_by_weight,
      quantityStep: Number(row.quantity_step),
      lowStockThreshold: Number(row.low_stock_threshold),
      isQuickItem: row.is_quick_item,
      isActive: row.is_active,
      recordVersion: row.record_version,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  }

  private mapSale(row: SaleRow): Sale {
    return {
      id: row.id,
      storeId: row.store_id,
      transactionNumber: row.transaction_number,
      customerId: row.customer_id,
      cashierUserId: row.cashier_user_id,
      deviceId: row.device_id,
      subtotal: row.subtotal,
      discount: row.discount,
      total: row.total,
      paymentMethod: row.payment_method,
      cashReceived: row.cash_received,
      changeAmount: row.change_amount,
      recordVersion: row.record_version,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  }

  private mapSaleItem(row: SaleItemRow): SaleItem {
    return {
      id: row.id,
      storeId: row.store_id,
      saleId: row.sale_id,
      productId: row.product_id,
      productNameSnapshot: row.product_name_snapshot,
      quantity: Number(row.quantity),
      unitPrice: row.unit_price,
      costPriceSnapshot: row.cost_price_snapshot,
      subtotal: row.subtotal,
      recordVersion: row.record_version,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  }

  private mapCustomer(row: CustomerRow): Customer {
    return {
      id: row.id,
      storeId: row.store_id,
      name: row.name,
      nickname: row.nickname,
      phoneNumber: row.phone_number,
      notes: row.notes,
      isActive: row.is_active,
      recordVersion: row.record_version,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  }

  private mapInventoryMovement(row: InventoryMovementRow): InventoryMovement {
    return {
      id: row.id,
      storeId: row.store_id,
      productId: row.product_id,
      saleId: row.sale_id,
      reason: row.reason,
      quantityDelta: Number(row.quantity_delta),
      stockAfter: Number(row.stock_after),
      note: row.note,
      actorUserId: row.actor_user_id,
      deviceId: row.device_id,
      recordVersion: row.record_version,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  }

  private mapUtangEntry(row: UtangEntryRow): UtangEntry {
    return {
      id: row.id,
      storeId: row.store_id,
      customerId: row.customer_id,
      saleId: row.sale_id,
      kind: row.kind,
      amount: row.amount,
      note: row.note,
      actorUserId: row.actor_user_id,
      recordVersion: row.record_version,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  }

  private mapExpense(row: ExpenseRow): Expense {
    return {
      id: row.id,
      storeId: row.store_id,
      category: row.category,
      description: row.description,
      amount: row.amount,
      occurredAt: row.occurred_at.toISOString(),
      actorUserId: row.actor_user_id,
      recordVersion: row.record_version,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  }

  private mapStaff(row: StaffRow): StaffMember {
    return {
      id: row.id,
      displayName: row.display_name,
      email: row.email,
      staffCode: row.staff_code,
      role: row.role,
      isActive: row.is_active,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  }
}
