import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getCachedConflictMessage, logout, requestSync, retryNeedsAttention } from '../lib/api';
import { db, getSession, removeLocalStoreData, saveSession } from '../lib/db';

const now = new Date().toISOString();
const emptySnapshot = {
  products: [], productUnits: [], sales: [], saleItems: [], inventoryMovements: [], customers: [], utangEntries: [], expenses: [], staff: [],
};

describe('local data protection', () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
    await saveSession({
      token: 'test-token',
      store: { id: 'store', name: 'GMA Store', createdAt: now, updatedAt: now },
      device: { id: 'device', storeId: 'store', name: 'Test browser', firstSyncedAt: now, lastSeenAt: now, createdAt: now, updatedAt: now },
      user: { id: 'user', displayName: 'Owner', email: 'owner@example.com', staffCode: null, role: 'owner' },
    });
    await db.sales.add({
      id: 'sale', storeId: 'store', transactionNumber: 'POS-LOCAL', customerId: null,
      cashierUserId: 'user', deviceId: 'device', subtotal: 100, discount: 0, total: 100,
      paymentMethod: 'cash', cashReceived: 100, changeAmount: 0, recordVersion: 1,
      createdAt: now, updatedAt: now,
    });
    await db.mutationQueue.add({
      id: 'command',
      request: {
        clientCommandId: '00000000-0000-4000-8000-000000000001', baseCursor: 0,
        command: { type: 'createCustomer', payload: { name: 'Offline customer' } },
      },
      createdAt: now, status: 'pending', attemptCount: 0, lastAttemptAt: null, errorMessage: null,
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await db.delete();
  });

  it('signs out without deleting cached sales or pending commands', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('server unavailable')));

    await logout();

    expect(await getSession()).toBeUndefined();
    expect(await db.sales.count()).toBe(1);
    expect(await db.mutationQueue.count()).toBe(1);
  });

  it('only erases pending work through the explicit local-data operation', async () => {
    await removeLocalStoreData();

    expect(await db.sales.count()).toBe(0);
    expect(await db.mutationQueue.count()).toBe(0);
  });

  it('surfaces sync validation details from the API', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      message: 'Invalid sync command',
      issues: [{ path: ['command', 'payload', 'productUnitId'], message: 'Invalid UUID' }],
    }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    })));

    await requestSync();

    const queued = await db.mutationQueue.toArray();
    expect(queued[0]).toMatchObject({
      status: 'needs_attention',
      errorMessage: 'Invalid sync command: command.payload.productUnitId: Invalid UUID',
    });
    expect(await getCachedConflictMessage()).toBe('Invalid sync command: command.payload.productUnitId: Invalid UUID');
  });

  it('repairs older queued restocks that used non-UUID local unit ids', async () => {
    await db.mutationQueue.clear();
    const productId = '00000000-0000-4000-8000-000000000101';
    await db.products.add({
      id: productId, storeId: 'store', barcode: null, sku: null, imageRevision: null,
      name: 'Milo', category: 'Drinks', costPrice: 1500, sellingPrice: 2000,
      stockQuantity: 52, unit: 'piece', soldByWeight: false, quantityStep: 1,
      lowStockThreshold: 5, isQuickItem: true, isActive: true, recordVersion: 2,
      createdAt: now, updatedAt: now, baseUnit: 'piece', stockBaseQuantity: 52,
    });
    await db.productUnits.add({
      id: 'piece', storeId: 'store', productId, name: 'piece', symbol: 'pc',
      multiplierBaseUnits: 1, quantityStep: 1, canSell: true, canRestock: true,
      allowAmountPricing: false, sellingPrice: 2000, costPrice: 1500, barcode: null,
      isBase: true, isActive: true, replacesUnitId: null, recordVersion: 1,
      createdAt: now, updatedAt: now,
    });
    await db.mutationQueue.add({
      id: '00000000-0000-4000-8000-000000000102',
      request: {
        clientCommandId: '00000000-0000-4000-8000-000000000102',
        baseCursor: 0,
        command: { type: 'receiveStock', payload: { productId, productUnitId: 'piece', inputQuantity: 2, note: 'Stock received' } },
      },
      createdAt: now,
      status: 'needs_attention',
      attemptCount: 1,
      lastAttemptAt: now,
      errorMessage: 'Invalid sync command: command.payload.productUnitId: Invalid UUID',
    });
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      status: 'applied', cursor: 1, snapshot: emptySnapshot,
    }))).mockResolvedValueOnce(new Response(JSON.stringify({
      cursor: 1, snapshot: emptySnapshot,
    })));
    vi.stubGlobal('fetch', fetchMock);

    await retryNeedsAttention();

    const sent = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(sent.command).toMatchObject({
      type: 'restockProduct',
      payload: { productId, mode: 'add', quantity: 2, expectedVersion: 1 },
    });
    expect(sent.command.payload.productUnitId).toBeUndefined();
    expect(await db.mutationQueue.count()).toBe(0);
  });
});
