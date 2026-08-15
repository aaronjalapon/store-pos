import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { logout } from '../lib/api';
import { db, getSession, removeLocalStoreData, saveSession } from '../lib/db';

const now = new Date().toISOString();

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
});
