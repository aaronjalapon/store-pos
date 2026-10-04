import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyServerDelta, db, getActiveStoreId, getSyncCursor, prepareStoreSwitch, replaceStoreSnapshot, saveSession } from '../lib/db';

const now = '2026-10-03T00:00:00.000Z';
const session = (storeId: string) => ({
  token: `token-${storeId}`,
  store: { id: storeId, name: storeId, createdAt: now, updatedAt: now },
  device: { id: `device-${storeId}`, storeId, name: 'Browser', firstSyncedAt: now, lastSeenAt: now, createdAt: now, updatedAt: now },
  user: { id: `user-${storeId}`, displayName: 'Owner', email: 'owner@example.com', staffCode: null, role: 'owner' as const },
});

describe('store-partitioned offline cache', () => {
  beforeEach(async () => { await db.delete(); await db.open(); });
  afterEach(async () => { await db.delete(); });

  it('advances empty delta cursors silently and labels server-applied changes', async () => {
    await saveSession(session('store-a'));
    const changed = vi.fn();
    window.addEventListener('pos-data-changed', changed);
    try {
      const delta = { cursor: 9, changes: [], tombstones: [], hasMore: false, historyWindowStart: now };
      await applyServerDelta(delta);
      await applyServerDelta({ ...delta, cursor: 10, patch: {} });
      expect(await getSyncCursor()).toBe(10);
      expect(changed).not.toHaveBeenCalled();
      await applyServerDelta({ ...delta, cursor: 11, patch: { products: [] } });
      expect(changed).toHaveBeenCalledTimes(1);
      expect(changed.mock.calls[0][0].detail).toEqual({ source: 'server' });
      await replaceStoreSnapshot({ products: [], productUnits: [], sales: [], saleItems: [], inventoryMovements: [], customers: [], utangEntries: [], expenses: [], staff: [] }, 12);
      expect(changed).toHaveBeenCalledTimes(2);
      expect(changed.mock.calls[1][0].detail).toEqual({ source: 'server' });
    } finally {
      window.removeEventListener('pos-data-changed', changed);
    }
  });

  it('blocks switching while the current store owns unresolved commands', async () => {
    await saveSession(session('store-a'));
    await db.mutationQueue.add({
      id: 'command-a', storeId: 'store-a', request: { clientCommandId: crypto.randomUUID(), baseCursor: 0, command: { type: 'createCustomer', payload: { name: 'Offline' } } },
      createdAt: now, status: 'pending', attemptCount: 0, lastAttemptAt: null, nextAttemptAt: null, errorMessage: null,
    });
    await expect(saveSession(session('store-b'))).rejects.toThrow('unresolved offline work');
    expect(await getActiveStoreId()).toBe('store-a');
  });

  it('clears the prior store view transactionally when switching cleanly', async () => {
    await saveSession(session('store-a'));
    await db.customers.add({ id: 'customer-a', storeId: 'store-a', name: 'Private customer', nickname: null, phoneNumber: null, notes: null, isActive: true, recordVersion: 1, createdAt: now, updatedAt: now });
    await prepareStoreSwitch('store-b');
    await saveSession(session('store-b'));
    expect(await db.customers.count()).toBe(0);
    expect(await getActiveStoreId()).toBe('store-b');
  });

  it('applies only the entity groups carried by a sync-v2 patch', async () => {
    await saveSession(session('store-a'));
    await db.customers.add({ id: 'customer-a', storeId: 'store-a', name: 'Keep me', nickname: null, phoneNumber: null, notes: null, isActive: true, recordVersion: 1, createdAt: now, updatedAt: now });
    await applyServerDelta({
      cursor: 9,
      changes: [{ cursor: 9, entityType: 'product', entityId: '*', operation: 'upsert', changedAt: now }],
      tombstones: [],
      hasMore: false,
      historyWindowStart: now,
      patch: {
        products: [{
          id: 'product-a', storeId: 'store-a', barcode: null, sku: null, imageRevision: null,
          name: 'Delta product', category: 'Test', costPrice: 100, sellingPrice: 200,
          stockQuantity: 3, unit: 'piece', soldByWeight: false, quantityStep: 1,
          lowStockThreshold: 1, isQuickItem: false, isActive: true, recordVersion: 1,
          createdAt: now, updatedAt: now,
        }],
        productUnits: [],
      },
    });

    expect((await db.products.toArray()).map((product) => product.name)).toEqual(['Delta product']);
    expect((await db.customers.toArray()).map((customer) => customer.name)).toEqual(['Keep me']);
    expect(await getSyncCursor()).toBe(9);
  });
});
