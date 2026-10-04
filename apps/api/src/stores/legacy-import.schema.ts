import { z } from 'zod';
import {
  inventoryAdjustmentReasons,
  inventoryMovementReasons,
  paymentMethods,
  qrPaymentAttentionReasons,
  qrPaymentConfirmationSources,
  qrPaymentStatuses,
  roles,
} from '@gma/contracts';

const iso = z.iso.datetime();
const uuid = z.string().uuid();
const nullableUuid = uuid.nullable();
const money = z.number().int().nonnegative();
const recordBase = {
  id: uuid,
  storeId: uuid,
  createdAt: iso,
  updatedAt: iso,
  recordVersion: z.number().int().positive(),
};

const product = z.object({
  ...recordBase,
  barcode: z.string().max(64).nullable(), sku: z.string().max(64).nullable(), imageRevision: nullableUuid,
  name: z.string().trim().min(1).max(160), category: z.string().trim().min(1).max(80),
  costPrice: money, sellingPrice: money, stockQuantity: z.number().nonnegative(), unit: z.string().min(1).max(40),
  soldByWeight: z.boolean(), quantityStep: z.number().positive(), lowStockThreshold: z.number().nonnegative(),
  isQuickItem: z.boolean(), isActive: z.boolean(), baseUnit: z.string().min(1).max(40).optional(),
  baseUnitId: nullableUuid.optional(), stockBaseQuantity: z.number().int().nonnegative().optional(),
  lowStockBaseThreshold: z.number().int().nonnegative().optional(), defaultSaleUnitId: nullableUuid.optional(),
  defaultRestockUnitId: nullableUuid.optional(), displayUnitId: nullableUuid.optional(),
}).strict();

const productUnit = z.object({
  ...recordBase, productId: uuid, name: z.string().min(1).max(80), symbol: z.string().max(20).nullable(),
  multiplierBaseUnits: z.number().int().positive(), quantityStep: z.number().positive(), canSell: z.boolean(),
  canRestock: z.boolean(), allowAmountPricing: z.boolean(), sellingPrice: money.nullable(), costPrice: money.nullable(),
  barcode: z.string().max(64).nullable(), isBase: z.boolean(), isActive: z.boolean(), replacesUnitId: nullableUuid,
}).strict();

const sale = z.object({
  ...recordBase, transactionNumber: z.string().min(1).max(64), customerId: nullableUuid, cashierUserId: uuid,
  deviceId: uuid, subtotal: money, discount: z.literal(0), total: money, paymentMethod: z.enum(paymentMethods),
  cashReceived: money.nullable(), changeAmount: z.number().int().nullable(),
}).strict();

const saleItem = z.object({
  ...recordBase, saleId: uuid, productId: uuid, productNameSnapshot: z.string().min(1).max(160),
  quantity: z.number().positive(), unitPrice: money, costPriceSnapshot: money, subtotal: money,
  productUnitId: nullableUuid.optional(), inputQuantity: z.number().positive().optional(),
  unitNameSnapshot: z.string().max(80).nullable().optional(), unitSymbolSnapshot: z.string().max(20).nullable().optional(),
  multiplierBaseUnitsSnapshot: z.number().int().positive().nullable().optional(), baseQuantity: z.number().int().positive().optional(),
}).strict();

const movement = z.object({
  ...recordBase, productId: uuid, saleId: nullableUuid, reason: z.enum(inventoryMovementReasons),
  quantityDelta: z.number(), stockAfter: z.number().nonnegative(), note: z.string().max(200).nullable(),
  actorUserId: uuid, deviceId: uuid, productUnitId: nullableUuid.optional(), inputMode: z.enum(['delta', 'absolute']).optional(),
  inputQuantity: z.number().nullable().optional(), inputUnitSnapshot: z.string().max(80).nullable().optional(),
  multiplierBaseUnitsSnapshot: z.number().int().positive().nullable().optional(), baseQuantityDelta: z.number().int().optional(),
  stockAfterBase: z.number().int().nonnegative().optional(), adjustmentReason: z.enum(inventoryAdjustmentReasons).nullable().optional(),
  actorDisplayNameSnapshot: z.string().max(120).nullable().optional(),
}).strict();

const customer = z.object({
  ...recordBase, name: z.string().min(1).max(120), nickname: z.string().max(120).nullable(),
  phoneNumber: z.string().max(40).nullable(), notes: z.string().max(1000).nullable(), isActive: z.boolean(),
}).strict();

const utang = z.object({
  ...recordBase, customerId: uuid, saleId: nullableUuid, kind: z.enum(['purchase', 'payment', 'adjustment']),
  amount: z.number().int().positive(), note: z.string().max(200).nullable(), actorUserId: uuid,
}).strict();

const expense = z.object({
  ...recordBase, category: z.string().min(1).max(120), description: z.string().min(1).max(200),
  amount: z.number().int().positive(), occurredAt: iso, actorUserId: uuid,
}).strict();

const staff = z.object({
  id: uuid, displayName: z.string().min(1).max(120), email: z.email().nullable(), staffCode: z.string().max(32).nullable(),
  role: z.enum(roles), isActive: z.boolean(), createdAt: iso, updatedAt: iso,
}).strict();

const qrPayment = z.object({
  ...recordBase, saleId: uuid, cashierUserId: uuid, cashierDisplayNameSnapshot: z.string().min(1).max(120),
  deviceId: uuid, amount: money, reference: z.string().min(1).max(80), normalizedReference: z.string().min(1).max(80),
  confirmationSource: z.enum(qrPaymentConfirmationSources), status: z.enum(qrPaymentStatuses),
  attentionReason: z.enum(qrPaymentAttentionReasons).nullable(), confirmedAt: iso, reviewedAt: iso.nullable(),
  reviewedByUserId: nullableUuid, reviewNote: z.string().max(200).nullable(),
}).strict();

const paymentSettings = z.object({
  storeId: uuid, imageRevision: uuid, contentType: z.enum(['image/png', 'image/webp', 'image/jpeg']),
  byteLength: z.number().int().positive().max(4 * 1024 * 1024), updatedAt: iso,
}).strict();

export const storeSnapshotSchema = z.object({
  products: z.array(product).max(50_000), productUnits: z.array(productUnit).max(200_000).optional(),
  sales: z.array(sale).max(250_000), saleItems: z.array(saleItem).max(1_000_000),
  inventoryMovements: z.array(movement).max(1_000_000), customers: z.array(customer).max(100_000),
  utangEntries: z.array(utang).max(500_000), expenses: z.array(expense).max(250_000),
  staff: z.array(staff).max(1_000), qrPayments: z.array(qrPayment).max(250_000).optional(),
  paymentSettings: paymentSettings.nullable().optional(),
}).strict().superRefine((snapshot, context) => {
  const products = new Set(snapshot.products.map((row) => row.id));
  const units = new Set((snapshot.productUnits ?? []).map((row) => row.id));
  const customers = new Set(snapshot.customers.map((row) => row.id));
  const sales = new Set(snapshot.sales.map((row) => row.id));
  const ensureUnique = (rows: { id: string }[], path: string) => {
    if (new Set(rows.map((row) => row.id)).size !== rows.length) context.addIssue({ code: 'custom', path: [path], message: 'IDs must be unique' });
  };
  ensureUnique(snapshot.products, 'products');
  ensureUnique(snapshot.productUnits ?? [], 'productUnits');
  ensureUnique(snapshot.customers, 'customers');
  ensureUnique(snapshot.sales, 'sales');
  for (const row of snapshot.productUnits ?? []) if (!products.has(row.productId)) context.addIssue({ code: 'custom', path: ['productUnits'], message: 'Unit references an unknown product' });
  for (const row of snapshot.sales) if (row.customerId && !customers.has(row.customerId)) context.addIssue({ code: 'custom', path: ['sales'], message: 'Sale references an unknown customer' });
  for (const row of snapshot.saleItems) {
    if (!sales.has(row.saleId) || !products.has(row.productId) || (row.productUnitId && !units.has(row.productUnitId))) {
      context.addIssue({ code: 'custom', path: ['saleItems'], message: 'Sale item has an invalid relationship' });
    }
  }
  for (const row of snapshot.inventoryMovements) {
    if (!products.has(row.productId) || (row.saleId && !sales.has(row.saleId)) || (row.productUnitId && !units.has(row.productUnitId))) {
      context.addIssue({ code: 'custom', path: ['inventoryMovements'], message: 'Inventory movement has an invalid relationship' });
    }
  }
  for (const row of snapshot.utangEntries) if (!customers.has(row.customerId) || (row.saleId && !sales.has(row.saleId))) context.addIssue({ code: 'custom', path: ['utangEntries'], message: 'Utang entry has an invalid relationship' });
  for (const row of snapshot.qrPayments ?? []) if (!sales.has(row.saleId)) context.addIssue({ code: 'custom', path: ['qrPayments'], message: 'QR payment references an unknown sale' });
});

export const legacyImportRequestSchema = z.object({ snapshot: storeSnapshotSchema }).strict();
