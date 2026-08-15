'use client';

import Dexie, { type EntityTable } from 'dexie';
import type {
  AuthSession,
  Customer,
  Expense,
  InventoryMovement,
  Product,
  Sale,
  SaleItem,
  StoreCommandRequest,
  StoreSnapshot,
  StoreSyncResponse,
  UtangEntry,
} from '@gma/contracts';

export interface AppSetting {
  key: string;
  value: unknown;
}

export interface MutationQueueItem {
  id: string;
  request: StoreCommandRequest;
  createdAt: string;
  status: 'pending' | 'syncing' | 'needs_attention';
  attemptCount: number;
  lastAttemptAt: string | null;
  errorMessage: string | null;
}

export interface ProductImageRecord {
  productId: string;
  revision: string;
  blob: Blob;
  contentType: 'image/webp' | 'image/jpeg';
  byteLength: number;
  syncStatus: 'pending' | 'synced';
  updatedAt: string;
}

export interface ProductImageQueueItem {
  id: string;
  productId: string;
  revision: string;
  operation: 'upload' | 'delete';
  attemptCount: number;
  lastAttemptAt: string | null;
}

export class PosDatabase extends Dexie {
  products!: EntityTable<Product, 'id'>;
  sales!: EntityTable<Sale, 'id'>;
  saleItems!: EntityTable<SaleItem, 'id'>;
  inventoryMovements!: EntityTable<InventoryMovement, 'id'>;
  customers!: EntityTable<Customer, 'id'>;
  utangEntries!: EntityTable<UtangEntry, 'id'>;
  expenses!: EntityTable<Expense, 'id'>;
  settings!: EntityTable<AppSetting, 'key'>;
  mutationQueue!: EntityTable<MutationQueueItem, 'id'>;
  productImages!: EntityTable<ProductImageRecord, 'productId'>;
  productImageQueue!: EntityTable<ProductImageQueueItem, 'id'>;

  constructor(name = 'gma-store-pos') {
    super(name);
    this.version(4).stores({
      products: 'id, &barcode, name, category, isQuickItem, isActive, updatedAt, recordVersion',
      sales: 'id, transactionNumber, createdAt, paymentMethod, customerId, cashierUserId',
      saleItems: 'id, saleId, productId, createdAt',
      inventoryMovements: 'id, productId, saleId, createdAt',
      customers: 'id, name, isActive, updatedAt, recordVersion',
      utangEntries: 'id, customerId, saleId, createdAt',
      expenses: 'id, category, occurredAt, createdAt',
      settings: 'key',
      mutationQueue: 'id, createdAt',
      productImages: 'productId, revision, syncStatus, updatedAt',
      productImageQueue: 'id, operation, productId, revision',
    });
    this.version(5).stores({
      products: 'id, &barcode, name, category, isQuickItem, isActive, updatedAt, recordVersion',
      sales: 'id, transactionNumber, createdAt, paymentMethod, customerId, cashierUserId',
      saleItems: 'id, saleId, productId, createdAt',
      inventoryMovements: 'id, productId, saleId, createdAt',
      customers: 'id, name, isActive, updatedAt, recordVersion',
      utangEntries: 'id, customerId, saleId, createdAt',
      expenses: 'id, category, occurredAt, createdAt',
      settings: 'key',
      mutationQueue: 'id, status, createdAt',
      productImages: 'productId, revision, syncStatus, updatedAt',
      productImageQueue: 'id, operation, productId, revision',
    }).upgrade(async (transaction) => {
      await transaction.table<MutationQueueItem>('mutationQueue').toCollection().modify((item) => {
        item.status = item.status ?? 'pending';
        item.attemptCount = item.attemptCount ?? 0;
        item.lastAttemptAt = item.lastAttemptAt ?? null;
        item.errorMessage = item.errorMessage ?? null;
      });
    });
  }
}

export const db = new PosDatabase();

const DEVICE_ID_KEY = 'deviceId';
const DEVICE_NAME_KEY = 'deviceName';
const SESSION_KEY = 'authSession';
const TOKEN_KEY = 'sessionToken';
const STORE_ID_KEY = 'activeStoreId';
const CURSOR_KEY = 'syncCursor';
const BOOTSTRAP_KEY = 'bootstrapComplete';
const CONFLICT_KEY = 'syncConflictMessage';

export async function getSetting<T>(key: string) {
  return (await db.settings.get(key))?.value as T | undefined;
}

export async function setSetting(key: string, value: unknown) {
  await db.settings.put({ key, value });
}

export async function getOrCreateDeviceId() {
  let deviceId = await getSetting<string>(DEVICE_ID_KEY);
  if (!deviceId) {
    deviceId = crypto.randomUUID();
    await setSetting(DEVICE_ID_KEY, deviceId);
  }
  return deviceId;
}

export async function getDeviceName() {
  return (await getSetting<string>(DEVICE_NAME_KEY)) || 'This browser';
}

export async function setDeviceName(name: string) {
  await setSetting(DEVICE_NAME_KEY, name.trim() || 'This browser');
}

export async function getSession() {
  return await getSetting<AuthSession>(SESSION_KEY);
}

export async function getSessionToken() {
  return await getSetting<string>(TOKEN_KEY);
}

export async function getActiveStoreId() {
  return await getSetting<string>(STORE_ID_KEY);
}

export async function getSyncCursor() {
  return (await getSetting<number>(CURSOR_KEY)) ?? 0;
}

export async function hasCompletedBootstrap() {
  return Boolean(await getSetting<boolean>(BOOTSTRAP_KEY));
}

export async function saveSession(session: AuthSession) {
  const writes = [
    setSetting(SESSION_KEY, session),
    setSetting(TOKEN_KEY, session.token),
  ];
  if (session.store) writes.push(setSetting(STORE_ID_KEY, session.store.id));
  await Promise.all(writes);
}

export async function clearSession() {
  await Promise.all([
    setSetting(SESSION_KEY, undefined),
    setSetting(TOKEN_KEY, undefined),
  ]);
}

export async function replaceStoreSnapshot(snapshot: StoreSnapshot, cursor: number, skipWhenQueued = false) {
  const replaced = await db.transaction(
    'rw',
    [db.products, db.sales, db.saleItems, db.inventoryMovements, db.customers, db.utangEntries, db.expenses, db.settings, db.mutationQueue],
    async () => {
      if (skipWhenQueued && await db.mutationQueue.count() > 0) return false;
      await Promise.all([
        db.products.clear(),
        db.sales.clear(),
        db.saleItems.clear(),
        db.inventoryMovements.clear(),
        db.customers.clear(),
        db.utangEntries.clear(),
        db.expenses.clear(),
      ]);
      await Promise.all([
        snapshot.products.length ? db.products.bulkPut(snapshot.products) : Promise.resolve(),
        snapshot.sales.length ? db.sales.bulkPut(snapshot.sales) : Promise.resolve(),
        snapshot.saleItems.length ? db.saleItems.bulkPut(snapshot.saleItems) : Promise.resolve(),
        snapshot.inventoryMovements.length ? db.inventoryMovements.bulkPut(snapshot.inventoryMovements) : Promise.resolve(),
        snapshot.customers.length ? db.customers.bulkPut(snapshot.customers) : Promise.resolve(),
        snapshot.utangEntries.length ? db.utangEntries.bulkPut(snapshot.utangEntries) : Promise.resolve(),
        snapshot.expenses.length ? db.expenses.bulkPut(snapshot.expenses) : Promise.resolve(),
      ]);
      await setSetting(CURSOR_KEY, cursor);
      await setSetting(BOOTSTRAP_KEY, true);
      return true;
    },
  );
  if (replaced) window.dispatchEvent(new Event('pos-data-changed'));
  return replaced;
}

export async function applyServerSync(sync: StoreSyncResponse) {
  return replaceStoreSnapshot(sync.snapshot, sync.cursor, true);
}

export async function queueCommand(request: StoreCommandRequest) {
  await db.mutationQueue.put({
    id: request.clientCommandId,
    request,
    createdAt: new Date().toISOString(),
    status: 'pending',
    attemptCount: 0,
    lastAttemptAt: null,
    errorMessage: null,
  });
}

export async function removeQueuedCommand(id: string) {
  await db.mutationQueue.delete(id);
}

export async function listQueuedCommands() {
  return db.mutationQueue.orderBy('createdAt').toArray();
}

export async function getMutationQueueSummary() {
  const items = await listQueuedCommands();
  return {
    pendingCount: items.filter((item) => item.status === 'pending' || item.status === 'syncing').length,
    needsAttentionCount: items.filter((item) => item.status === 'needs_attention').length,
    pendingSaleCount: items.filter((item) => (item.status === 'pending' || item.status === 'syncing') && item.request.command.type === 'completeSale').length,
    needsAttentionSaleCount: items.filter((item) => item.status === 'needs_attention' && item.request.command.type === 'completeSale').length,
    totalCount: items.length,
  };
}

export async function setConflictMessage(message: string) {
  await setSetting(CONFLICT_KEY, message);
  window.dispatchEvent(new Event('pos-sync-conflict'));
}

export async function clearConflictMessage() {
  await setSetting(CONFLICT_KEY, '');
}

export async function getConflictMessage() {
  return (await getSetting<string>(CONFLICT_KEY)) || '';
}

export async function getStoreContext() {
  const session = await getSession();
  if (!session?.store || !session.device) throw new Error('Choose a store first');
  return {
    session,
    storeId: session.store.id,
    deviceId: session.device.id,
    userId: session.user.id,
    role: session.user.role,
  };
}

export async function signOutLocally() {
  await clearSession();
}

export async function removeLocalStoreData() {
  await db.transaction('rw', [db.products, db.sales, db.saleItems, db.inventoryMovements, db.customers, db.utangEntries, db.expenses, db.mutationQueue, db.productImages, db.productImageQueue], async () => {
    await Promise.all([
      db.products.clear(),
      db.sales.clear(),
      db.saleItems.clear(),
      db.inventoryMovements.clear(),
      db.customers.clear(),
      db.utangEntries.clear(),
      db.expenses.clear(),
      db.mutationQueue.clear(),
      db.productImages.clear(),
      db.productImageQueue.clear(),
    ]);
  });
  await clearSession();
  await setSetting(BOOTSTRAP_KEY, false);
  await setSetting(CURSOR_KEY, 0);
  await clearConflictMessage();
}

/** @deprecated Use signOutLocally for logout or removeLocalStoreData for intentional device erasure. */
export const resetLocalStoreForLogout = removeLocalStoreData;
