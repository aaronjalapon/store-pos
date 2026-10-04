'use client';

import Dexie, { type EntityTable } from 'dexie';
import type {
  AuthSession,
  ActivityActor,
  ActivityLog,
  Customer,
  Expense,
  InventoryMovement,
  Product,
  ProductUnit,
  QrPayment,
  QrPhPaymentSettings,
  Sale,
  SaleItem,
  StoreCommandRequest,
  StoreDeltaSyncResponse,
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
  storeId: string;
  request: StoreCommandRequest;
  createdAt: string;
  status: 'pending' | 'syncing' | 'needs_attention';
  attemptCount: number;
  lastAttemptAt: string | null;
  nextAttemptAt: string | null;
  errorMessage: string | null;
  actor?: ActivityActor;
  deviceName?: string | null;
}

export type ActivityLogCacheRecord = ActivityLog;

export interface ProductImageRecord {
  productId: string;
  storeId: string;
  revision: string;
  blob: Blob;
  contentType: 'image/webp' | 'image/jpeg';
  byteLength: number;
  syncStatus: 'pending' | 'synced';
  updatedAt: string;
}

export interface ProductImageQueueItem {
  id: string;
  storeId: string;
  productId: string;
  revision: string;
  operation: 'upload' | 'delete';
  attemptCount: number;
  lastAttemptAt: string | null;
}

export interface QrPhImageRecord {
  key: 'qrph';
  storeId: string;
  revision: string;
  blob: Blob;
  contentType: QrPhPaymentSettings['contentType'];
  byteLength: number;
  updatedAt: string;
}

export class PosDatabase extends Dexie {
  products!: EntityTable<Product, 'id'>;
  productUnits!: EntityTable<ProductUnit, 'id'>;
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
  activityLogCache!: EntityTable<ActivityLogCacheRecord, 'id'>;
  qrPayments!: EntityTable<QrPayment, 'id'>;
  paymentSettings!: EntityTable<QrPhPaymentSettings, 'storeId'>;
  qrPhImages!: EntityTable<QrPhImageRecord, 'key'>;

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
    this.version(6).stores({
      products: 'id, &barcode, name, category, isQuickItem, isActive, updatedAt, recordVersion, baseUnit',
      productUnits: 'id, productId, barcode, isActive, canSell, canRestock, updatedAt',
      sales: 'id, transactionNumber, createdAt, paymentMethod, customerId, cashierUserId',
      saleItems: 'id, saleId, productId, productUnitId, createdAt',
      inventoryMovements: 'id, productId, productUnitId, saleId, createdAt',
      customers: 'id, name, isActive, updatedAt, recordVersion',
      utangEntries: 'id, customerId, saleId, createdAt',
      expenses: 'id, category, occurredAt, createdAt',
      settings: 'key',
      mutationQueue: 'id, status, createdAt',
      productImages: 'productId, revision, syncStatus, updatedAt',
      productImageQueue: 'id, operation, productId, revision',
    });
    this.version(7).stores({
      products: 'id, &barcode, name, category, isQuickItem, isActive, updatedAt, recordVersion, baseUnit',
      productUnits: 'id, productId, barcode, isActive, canSell, canRestock, updatedAt',
      sales: 'id, transactionNumber, createdAt, paymentMethod, customerId, cashierUserId',
      saleItems: 'id, saleId, productId, productUnitId, createdAt',
      inventoryMovements: 'id, productId, productUnitId, saleId, createdAt',
      customers: 'id, name, isActive, updatedAt, recordVersion',
      utangEntries: 'id, customerId, saleId, createdAt',
      expenses: 'id, category, occurredAt, createdAt',
      settings: 'key',
      mutationQueue: 'id, status, createdAt',
      productImages: 'productId, revision, syncStatus, updatedAt',
      productImageQueue: 'id, operation, productId, revision',
      activityLogCache: 'id, storeId, category, actor.userId, actor.role, occurredAt, clientCommandId',
    });
    this.version(8).stores({
      products: 'id, &barcode, name, category, isQuickItem, isActive, updatedAt, recordVersion, baseUnit',
      productUnits: 'id, productId, barcode, isActive, canSell, canRestock, updatedAt',
      sales: 'id, transactionNumber, createdAt, paymentMethod, customerId, cashierUserId',
      saleItems: 'id, saleId, productId, productUnitId, createdAt',
      inventoryMovements: 'id, productId, productUnitId, saleId, createdAt',
      customers: 'id, name, isActive, updatedAt, recordVersion',
      utangEntries: 'id, customerId, saleId, createdAt',
      expenses: 'id, category, occurredAt, createdAt',
      settings: 'key',
      mutationQueue: 'id, status, createdAt',
      productImages: 'productId, revision, syncStatus, updatedAt',
      productImageQueue: 'id, operation, productId, revision',
      activityLogCache: 'id, storeId, category, actor.userId, actor.role, occurredAt, clientCommandId',
      qrPayments: 'id, &saleId, storeId, status, normalizedReference, confirmedAt',
      paymentSettings: 'storeId, imageRevision, updatedAt',
      qrPhImages: 'key, revision, updatedAt',
    });
    this.version(9).stores({
      products: 'id, storeId, &barcode, name, category, isQuickItem, isActive, updatedAt, recordVersion, baseUnit',
      productUnits: 'id, storeId, productId, barcode, isActive, canSell, canRestock, updatedAt',
      sales: 'id, storeId, transactionNumber, createdAt, paymentMethod, customerId, cashierUserId',
      saleItems: 'id, storeId, saleId, productId, productUnitId, createdAt',
      inventoryMovements: 'id, storeId, productId, productUnitId, saleId, createdAt',
      customers: 'id, storeId, name, isActive, updatedAt, recordVersion',
      utangEntries: 'id, storeId, customerId, saleId, createdAt',
      expenses: 'id, storeId, category, occurredAt, createdAt',
      settings: 'key',
      mutationQueue: 'id, storeId, status, createdAt',
      productImages: 'productId, storeId, revision, syncStatus, updatedAt',
      productImageQueue: 'id, storeId, operation, productId, revision',
      activityLogCache: 'id, storeId, category, actor.userId, actor.role, occurredAt, clientCommandId',
      qrPayments: 'id, storeId, &saleId, status, normalizedReference, confirmedAt',
      paymentSettings: 'storeId, imageRevision, updatedAt',
      qrPhImages: 'key, storeId, revision, updatedAt',
    }).upgrade(async (transaction) => {
      const activeStoreId = (await transaction.table<AppSetting>('settings').get(STORE_ID_KEY))?.value;
      if (typeof activeStoreId !== 'string' || !activeStoreId) return;
      await Promise.all([
        transaction.table<MutationQueueItem>('mutationQueue').toCollection().modify((item) => { item.storeId = item.storeId || activeStoreId; }),
        transaction.table<ProductImageRecord>('productImages').toCollection().modify((item) => { item.storeId = item.storeId || activeStoreId; }),
        transaction.table<ProductImageQueueItem>('productImageQueue').toCollection().modify((item) => { item.storeId = item.storeId || activeStoreId; }),
        transaction.table<QrPhImageRecord>('qrPhImages').toCollection().modify((item) => { item.storeId = item.storeId || activeStoreId; }),
      ]);
      await transaction.table<MutationQueueItem>('mutationQueue').toCollection().modify((item) => { item.nextAttemptAt = item.nextAttemptAt ?? null; });
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
  if (session.store) await prepareStoreSwitch(session.store.id);
  const writes = [
    setSetting(SESSION_KEY, session),
    setSetting(TOKEN_KEY, session.token),
  ];
  if (session.store) writes.push(setSetting(STORE_ID_KEY, session.store.id));
  await Promise.all(writes);
}

export async function prepareStoreSwitch(nextStoreId: string) {
  const currentStoreId = await getActiveStoreId();
  if (!currentStoreId || currentStoreId === nextStoreId) return;
  const [commands, imageOperations] = await Promise.all([
    db.mutationQueue.where('storeId').equals(currentStoreId).count(),
    db.productImageQueue.where('storeId').equals(currentStoreId).count(),
  ]);
  if (commands + imageOperations > 0) {
    throw new Error('This device has unresolved offline work for another store. Reconnect and finish syncing it before switching stores.');
  }
  await clearCachedStoreData();
}

async function clearCachedStoreData() {
  await db.transaction('rw', [db.products, db.productUnits, db.sales, db.saleItems, db.inventoryMovements, db.customers, db.utangEntries, db.expenses, db.productImages, db.productImageQueue, db.activityLogCache, db.qrPayments, db.paymentSettings, db.qrPhImages, db.settings], async () => {
    await Promise.all([
      db.products.clear(), db.productUnits.clear(), db.sales.clear(), db.saleItems.clear(),
      db.inventoryMovements.clear(), db.customers.clear(), db.utangEntries.clear(), db.expenses.clear(),
      db.productImages.clear(), db.productImageQueue.clear(), db.activityLogCache.clear(),
      db.qrPayments.clear(), db.paymentSettings.clear(), db.qrPhImages.clear(),
    ]);
    await db.settings.bulkPut([
      { key: BOOTSTRAP_KEY, value: false },
      { key: CURSOR_KEY, value: 0 },
      { key: CONFLICT_KEY, value: '' },
    ]);
  });
}

export async function clearSession() {
  await Promise.all([
    setSetting(SESSION_KEY, undefined),
    setSetting(TOKEN_KEY, undefined),
  ]);
}

export async function replaceStoreSnapshot(snapshot: StoreSnapshot, cursor: number, skipWhenQueued = false) {
  const activeStoreId = await getActiveStoreId();
  const snapshotStoreIds = [
    ...snapshot.products, ...(snapshot.productUnits ?? []), ...snapshot.sales, ...snapshot.saleItems,
    ...snapshot.inventoryMovements, ...snapshot.customers, ...snapshot.utangEntries, ...snapshot.expenses,
    ...(snapshot.qrPayments ?? []), ...(snapshot.paymentSettings ? [snapshot.paymentSettings] : []),
  ].map((record) => record.storeId);
  if (activeStoreId && snapshotStoreIds.some((storeId) => storeId !== activeStoreId)) {
    throw new Error('Refusing to cache data for a different store');
  }
  const replaced = await db.transaction(
    'rw',
    [db.products, db.productUnits, db.sales, db.saleItems, db.inventoryMovements, db.customers, db.utangEntries, db.expenses, db.qrPayments, db.paymentSettings, db.settings, db.mutationQueue],
    async () => {
      if (skipWhenQueued && activeStoreId && await db.mutationQueue.where('storeId').equals(activeStoreId).count() > 0) return false;
      await Promise.all([
        db.products.clear(),
        db.productUnits.clear(),
        db.sales.clear(),
        db.saleItems.clear(),
        db.inventoryMovements.clear(),
        db.customers.clear(),
        db.utangEntries.clear(),
        db.expenses.clear(),
        db.qrPayments.clear(),
        db.paymentSettings.clear(),
      ]);
      await Promise.all([
        snapshot.products.length ? db.products.bulkPut(snapshot.products) : Promise.resolve(),
        snapshot.productUnits?.length ? db.productUnits.bulkPut(snapshot.productUnits) : Promise.resolve(),
        snapshot.sales.length ? db.sales.bulkPut(snapshot.sales) : Promise.resolve(),
        snapshot.saleItems.length ? db.saleItems.bulkPut(snapshot.saleItems) : Promise.resolve(),
        snapshot.inventoryMovements.length ? db.inventoryMovements.bulkPut(snapshot.inventoryMovements) : Promise.resolve(),
        snapshot.customers.length ? db.customers.bulkPut(snapshot.customers) : Promise.resolve(),
        snapshot.utangEntries.length ? db.utangEntries.bulkPut(snapshot.utangEntries) : Promise.resolve(),
        snapshot.expenses.length ? db.expenses.bulkPut(snapshot.expenses) : Promise.resolve(),
        snapshot.qrPayments?.length ? db.qrPayments.bulkPut(snapshot.qrPayments) : Promise.resolve(),
        snapshot.paymentSettings ? db.paymentSettings.put(snapshot.paymentSettings) : Promise.resolve(),
      ]);
      await setSetting(CURSOR_KEY, cursor);
      await setSetting(BOOTSTRAP_KEY, true);
      return true;
    },
  );
  if (replaced) window.dispatchEvent(new CustomEvent('pos-data-changed', { detail: { source: 'server' } }));
  return replaced;
}

export async function applyServerSync(sync: StoreSyncResponse) {
  return replaceStoreSnapshot(sync.snapshot, sync.cursor, true);
}

export async function applyServerDelta(delta: StoreDeltaSyncResponse) {
  const storeId = await getActiveStoreId();
  if (!storeId) throw new Error('Choose a store before applying server changes');
  const patch = delta.patch;
  if (patch) {
    const records = [
      ...(patch.products ?? []), ...(patch.productUnits ?? []), ...(patch.sales ?? []),
      ...(patch.saleItems ?? []), ...(patch.inventoryMovements ?? []), ...(patch.customers ?? []),
      ...(patch.utangEntries ?? []), ...(patch.expenses ?? []), ...(patch.qrPayments ?? []),
      ...(patch.paymentSettings ? [patch.paymentSettings] : []),
    ];
    if (records.some((record) => record.storeId !== storeId)) {
      throw new Error('Refusing to apply changes for a different store');
    }
  }
  const applied = await db.transaction(
    'rw',
    [db.products, db.productUnits, db.sales, db.saleItems, db.inventoryMovements, db.customers, db.utangEntries, db.expenses, db.qrPayments, db.paymentSettings, db.settings, db.mutationQueue],
    async () => {
      if (await db.mutationQueue.where('storeId').equals(storeId).count() > 0) return false;
      if (patch?.products !== undefined) {
        await db.products.where('storeId').equals(storeId).delete();
        if (patch.products.length) await db.products.bulkPut(patch.products);
      }
      if (patch?.productUnits !== undefined) {
        await db.productUnits.where('storeId').equals(storeId).delete();
        if (patch.productUnits.length) await db.productUnits.bulkPut(patch.productUnits);
      }
      if (patch?.sales !== undefined) {
        await db.sales.where('storeId').equals(storeId).delete();
        if (patch.sales.length) await db.sales.bulkPut(patch.sales);
      }
      if (patch?.saleItems !== undefined) {
        await db.saleItems.where('storeId').equals(storeId).delete();
        if (patch.saleItems.length) await db.saleItems.bulkPut(patch.saleItems);
      }
      if (patch?.inventoryMovements !== undefined) {
        await db.inventoryMovements.where('storeId').equals(storeId).delete();
        if (patch.inventoryMovements.length) await db.inventoryMovements.bulkPut(patch.inventoryMovements);
      }
      if (patch?.customers !== undefined) {
        await db.customers.where('storeId').equals(storeId).delete();
        if (patch.customers.length) await db.customers.bulkPut(patch.customers);
      }
      if (patch?.utangEntries !== undefined) {
        await db.utangEntries.where('storeId').equals(storeId).delete();
        if (patch.utangEntries.length) await db.utangEntries.bulkPut(patch.utangEntries);
      }
      if (patch?.expenses !== undefined) {
        await db.expenses.where('storeId').equals(storeId).delete();
        if (patch.expenses.length) await db.expenses.bulkPut(patch.expenses);
      }
      if (patch?.qrPayments !== undefined) {
        await db.qrPayments.where('storeId').equals(storeId).delete();
        if (patch.qrPayments.length) await db.qrPayments.bulkPut(patch.qrPayments);
      }
      if (patch && Object.prototype.hasOwnProperty.call(patch, 'paymentSettings')) {
        await db.paymentSettings.where('storeId').equals(storeId).delete();
        if (patch.paymentSettings) await db.paymentSettings.put(patch.paymentSettings);
      }
      await setSetting(CURSOR_KEY, delta.cursor);
      return true;
    },
  );
  const hasEntityChanges = patch && Object.keys(patch).length > 0;
  if (applied && hasEntityChanges && typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('pos-data-changed', { detail: { source: 'server' } }));
  }
  return applied;
}

export async function queueCommand(request: StoreCommandRequest) {
  const [session, deviceName, latest] = await Promise.all([getSession(), getDeviceName(), db.mutationQueue.orderBy('createdAt').last()]);
  const createdAt = new Date(Math.max(Date.now(), latest ? Date.parse(latest.createdAt) + 1 : 0)).toISOString();
  await db.mutationQueue.put({
    id: request.clientCommandId,
    storeId: session?.store?.id ?? (() => { throw new Error('Choose a store before creating offline work'); })(),
    request,
    createdAt,
    status: 'pending',
    attemptCount: 0,
    lastAttemptAt: null,
    nextAttemptAt: null,
    errorMessage: null,
    actor: session ? {
      userId: session.user.id,
      displayName: session.user.displayName,
      role: session.user.role,
    } : undefined,
    deviceName,
  });
}

export async function cacheActivityLogs(activity: ActivityLog[]) {
  if (!activity.length) return;
  await db.transaction('rw', db.activityLogCache, async () => {
    await db.activityLogCache.bulkPut(activity.filter((item) => item.status === 'confirmed'));
    const all = await db.activityLogCache.orderBy('occurredAt').reverse().toArray();
    if (all.length > 500) await db.activityLogCache.bulkDelete(all.slice(500).map((item) => item.id));
  });
}

export async function getCachedActivityLogs(storeId: string) {
  const activity = await db.activityLogCache.where('storeId').equals(storeId).toArray();
  return activity.sort((left, right) => right.occurredAt.localeCompare(left.occurredAt));
}

export async function removeQueuedCommand(id: string) {
  await db.mutationQueue.delete(id);
}

export async function listQueuedCommands() {
  const storeId = await getActiveStoreId();
  if (!storeId) return [];
  const items = await db.mutationQueue.where('storeId').equals(storeId).toArray();
  return items.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
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
  await db.transaction('rw', [db.products, db.productUnits, db.sales, db.saleItems, db.inventoryMovements, db.customers, db.utangEntries, db.expenses, db.mutationQueue, db.productImages, db.productImageQueue, db.activityLogCache, db.qrPayments, db.paymentSettings, db.qrPhImages], async () => {
    await Promise.all([
      db.products.clear(),
      db.productUnits.clear(),
      db.sales.clear(),
      db.saleItems.clear(),
      db.inventoryMovements.clear(),
      db.customers.clear(),
      db.utangEntries.clear(),
      db.expenses.clear(),
      db.mutationQueue.clear(),
      db.productImages.clear(),
      db.productImageQueue.clear(),
      db.activityLogCache.clear(),
      db.qrPayments.clear(),
      db.paymentSettings.clear(),
      db.qrPhImages.clear(),
    ]);
  });
  await clearSession();
  await setSetting(BOOTSTRAP_KEY, false);
  await setSetting(CURSOR_KEY, 0);
  await clearConflictMessage();
}

/** @deprecated Use signOutLocally for logout or removeLocalStoreData for intentional device erasure. */
export const resetLocalStoreForLogout = removeLocalStoreData;
