import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { db, saveSession } from '../lib/db';
import { completeSale, restockProduct, saveProduct } from '../lib/pos';

const now = new Date().toISOString();

describe('offline checkout transaction', () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
    await saveSession({
      token: 'test-token',
      store: { id: 'store', name: 'GMA Store', createdAt: now, updatedAt: now },
      device: { id: 'device', storeId: 'store', name: 'Test browser', firstSyncedAt: now, lastSeenAt: now, createdAt: now, updatedAt: now },
      user: { id: 'user', displayName: 'Owner', email: 'owner@example.com', staffCode: null, role: 'owner' },
    });
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
    await db.products.add({
      id: '71551dba-4438-47b8-995c-8fe6153e307c', storeId: 'store', barcode: null, sku: null, imageRevision: null,
      name: 'Egg', category: 'Food', costPrice: 700, sellingPrice: 900, stockQuantity: 3,
      unit: 'piece', soldByWeight: false, quantityStep: 1,
      lowStockThreshold: 1, isQuickItem: true, isActive: true,
      createdAt: now, updatedAt: now, recordVersion: 1,
    });
  });

  afterEach(async () => {
    await db.delete();
  });

  it('atomically saves sale, item, inventory movement, and stock decrease without a server', async () => {
    const product = (await db.products.toArray())[0];
    const result = await completeSale({ cart: [{ product, quantity: 2 }], paymentMethod: 'cash', cashReceived: 2000, customerId: null });
    expect(result.change).toBe(200);
    expect(await db.sales.count()).toBe(1);
    expect(await db.saleItems.count()).toBe(1);
    expect(await db.inventoryMovements.count()).toBe(1);
    expect((await db.products.get(product.id))?.stockQuantity).toBe(1);
  });

  it('rolls back all writes when requested stock is unavailable', async () => {
    const product = (await db.products.toArray())[0];
    await expect(completeSale({ cart: [{ product, quantity: 4 }], paymentMethod: 'cash', cashReceived: 5000, customerId: null }))
      .rejects.toThrow('Only 3');
    expect(await db.sales.count()).toBe(0);
    expect(await db.saleItems.count()).toBe(0);
    expect((await db.products.get(product.id))?.stockQuantity).toBe(3);
  });

  it('quick restocks by adding incoming stock from the current product row', async () => {
    const product = (await db.products.toArray())[0];
    await db.products.update(product.id, { stockQuantity: 5 });
    await restockProduct(product, 'add', 12);
    const movement = await db.inventoryMovements.where('productId').equals(product.id).first();
    expect((await db.products.get(product.id))?.stockQuantity).toBe(17);
    expect(movement).toMatchObject({ reason: 'restock', quantityDelta: 12, stockAfter: 17 });
  });

  it('quick restocks by setting the final stock total', async () => {
    const product = (await db.products.toArray())[0];
    await db.products.update(product.id, { stockQuantity: 5 });
    await restockProduct(product, 'set', 12);
    const movement = await db.inventoryMovements.where('productId').equals(product.id).first();
    expect((await db.products.get(product.id))?.stockQuantity).toBe(12);
    expect(movement).toMatchObject({ reason: 'restock', quantityDelta: 7, stockAfter: 12 });
  });

  it('charges and deducts a fractional weighted quantity', async () => {
    const base = (await db.products.toArray())[0];
    const pork = await saveProduct({
      name: 'Pork', category: 'Food', costPrice: 25000, sellingPrice: 32000,
      stockQuantity: 5, unit: 'kg', soldByWeight: true, quantityStep: 0.01,
      lowStockThreshold: 1, isQuickItem: true,
    });
    const result = await completeSale({
      cart: [{ product: pork, quantity: 0.75 }], paymentMethod: 'cash', cashReceived: 30000, customerId: null,
    });
    expect(result.total).toBe(24000);
    expect(result.change).toBe(6000);
    expect((await db.products.get(pork.id))?.stockQuantity).toBe(4.25);
    expect((await db.saleItems.where('productId').equals(pork.id).first())?.subtotal).toBe(24000);
    expect((await db.products.get(base.id))?.stockQuantity).toBe(3);
  });

  it('preserves an exact peso amount and derives the sold weight', async () => {
    const pork = await saveProduct({
      name: 'Pork', category: 'Food', costPrice: 25000, sellingPrice: 32000,
      stockQuantity: 5, unit: 'kg', soldByWeight: true, quantityStep: 0.01,
      lowStockThreshold: 1, isQuickItem: true,
    });
    const result = await completeSale({
      cart: [{ product: pork, quantity: 1, pricingMode: 'amount', enteredAmount: 10000 }],
      paymentMethod: 'cash', cashReceived: 12000, customerId: null,
    });
    const item = await db.saleItems.where('productId').equals(pork.id).first();
    expect(result).toMatchObject({ total: 10000, change: 2000 });
    expect(item).toMatchObject({ quantity: 0.3125, unitPrice: 32000, subtotal: 10000 });
    expect((await db.products.get(pork.id))?.stockQuantity).toBe(4.6875);
    expect((await db.inventoryMovements.where('productId').equals(pork.id).first())?.quantityDelta).toBe(-0.3125);
  });

  it('uses the exact amount for an Utang entry', async () => {
    const pork = await saveProduct({
      name: 'Pork', category: 'Food', costPrice: 25000, sellingPrice: 32000,
      stockQuantity: 5, unit: 'kg', soldByWeight: true, quantityStep: 0.01,
      lowStockThreshold: 1, isQuickItem: true,
    });
    await db.customers.add({ id: 'customer', storeId: 'store', name: 'Nena', nickname: null, phoneNumber: null, notes: null, isActive: true, createdAt: now, updatedAt: now, recordVersion: 1 });
    await completeSale({
      cart: [{ product: pork, quantity: 1, pricingMode: 'amount', enteredAmount: 24000 }],
      paymentMethod: 'utang', cashReceived: null, customerId: 'customer',
    });
    expect((await db.utangEntries.where('customerId').equals('customer').first())?.amount).toBe(24000);
  });

  it('rejects amount-mode sales above available weighted stock', async () => {
    const pork = await saveProduct({
      name: 'Pork', category: 'Food', costPrice: 25000, sellingPrice: 32000,
      stockQuantity: 0.25, unit: 'kg', soldByWeight: true, quantityStep: 0.01,
      lowStockThreshold: 0.1, isQuickItem: true,
    });
    await expect(completeSale({
      cart: [{ product: pork, quantity: 0.25, pricingMode: 'amount', enteredAmount: 10000 }],
      paymentMethod: 'cash', cashReceived: 10000, customerId: null,
    })).rejects.toThrow('up to ₱80.00');
    expect(await db.sales.count()).toBe(0);
    expect((await db.products.get(pork.id))?.stockQuantity).toBe(0.25);
  });

  it('rejects decimal quantities for regular products', async () => {
    const egg = (await db.products.toArray())[0];
    await expect(completeSale({ cart: [{ product: egg, quantity: 0.5 }], paymentMethod: 'cash', cashReceived: 1000, customerId: null }))
      .rejects.toThrow('increments of 1 piece');
  });

  it('stores product images separately and queues replacement cleanup', async () => {
    const firstImage = { revision: crypto.randomUUID(), blob: new Blob(['first'], { type: 'image/webp' }), contentType: 'image/webp' as const };
    const product = await saveProduct({
      name: 'Coffee', category: 'Drinks', barcode: '12345678', costPrice: 500,
      sellingPrice: 700, stockQuantity: 10, unit: 'sachet', lowStockThreshold: 2,
      isQuickItem: true, image: firstImage,
    });
    expect(product.imageRevision).toBe(firstImage.revision);
    expect((await db.productImages.get(product.id))?.byteLength).toBe(5);
    expect(await db.productImageQueue.get(`upload:${product.id}:${firstImage.revision}`)).toBeTruthy();

    await db.productImageQueue.clear();
    const replacement = { revision: crypto.randomUUID(), blob: new Blob(['new'], { type: 'image/jpeg' }), contentType: 'image/jpeg' as const };
    await saveProduct({
      id: product.id, name: product.name, category: product.category, barcode: product.barcode ?? undefined,
      costPrice: product.costPrice, sellingPrice: product.sellingPrice, stockQuantity: product.stockQuantity,
      unit: product.unit, lowStockThreshold: product.lowStockThreshold, isQuickItem: product.isQuickItem, image: replacement,
    });
    expect((await db.productImages.get(product.id))?.revision).toBe(replacement.revision);
    expect(await db.productImageQueue.get(`upload:${product.id}:${replacement.revision}`)).toBeTruthy();
    expect(await db.productImageQueue.get(`delete:${product.id}:${firstImage.revision}`)).toBeTruthy();
  });

  it('rejects duplicate barcodes without replacing form data', async () => {
    await expect(saveProduct({
      name: 'Another Egg', category: 'Food', barcode: '4800000000000', costPrice: 500,
      sellingPrice: 800, stockQuantity: 4, unit: 'piece', lowStockThreshold: 1, isQuickItem: false,
    })).resolves.toBeTruthy();
    await expect(saveProduct({
      name: 'Duplicate', category: 'Food', barcode: '4800000000000', costPrice: 500,
      sellingPrice: 800, stockQuantity: 4, unit: 'piece', lowStockThreshold: 1, isQuickItem: false,
    })).rejects.toThrow('already assigned');
  });
});
