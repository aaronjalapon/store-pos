// Destructive integration checks. Only run against the disposable audit stack after test:real-stack.
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { NestFactory } from '@nestjs/core';
import appModule from '../apps/api/dist/app.module.js';
import backupModule from '../apps/api/dist/backups/backups.service.js';
import restoreModule from '../apps/api/dist/backups/backup-restore.service.js';
import dataModule from '../apps/api/dist/stores/store-data.service.js';
import databaseModule from '../apps/api/dist/database/database.service.js';
import retentionModule from '../apps/api/dist/operations/retention.service.js';
import objectModule from '../apps/api/dist/storage/object-operations.service.js';
import configModule from '../apps/api/dist/config/validate-production-config.js';

const url = process.env.AUDIT_DATABASE_URL;
assert.ok(url && new URL(url).pathname.includes('audit'), 'An explicitly disposable audit database is required');
assert.equal(process.env.DATABASE_URL, url, 'Nest services and test client must use the same audit database');
const api = process.env.AUDIT_API_URL ?? 'http://127.0.0.1:4400';
assert.ok(['localhost', '127.0.0.1'].includes(new URL(api).hostname));
const db = new pg.Client({ connectionString: url });
await db.connect();
let app;
const checks = [];
const pass = (name) => { checks.push(name); console.log(`PASS ${name}`); };
try {
  const { rows: [owner] } = await db.query(`SELECT u.id, u.email, m.store_id, d.id AS device_id
    FROM users u JOIN store_memberships m ON m.user_id=u.id JOIN devices d ON d.store_id=m.store_id
    WHERE m.role='owner' AND u.email LIKE 'audit-%@example.invalid' AND d.is_enrolled
    ORDER BY d.created_at LIMIT 1`);
  assert.ok(owner, 'Run test:real-stack first');
  const storeId = owner.store_id;
  async function request(path, body, token, extra = {}) {
    const response = await fetch(`${api}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let value; try { value = JSON.parse(text); } catch { value = text; }
    return { status: response.status, value, headers: response.headers };
  }
  const login = await request('/v1/auth/login', { email: owner.email,
    password: owner.email.includes('-a@') ? 'AuditPassword123!' : 'AuditPassword456!', deviceId: owner.device_id, deviceName: 'Final QA' });
  assert.equal(login.status, 200);
  const token = login.value.token;
  await request(`/v1/stores/${storeId}/bootstrap`, undefined, token);
  const principal = { userId: owner.id, storeId, deviceId: owner.device_id, role: 'owner', displayName: 'QA Owner', email: owner.email, staffCode: null };
  const command = async (command, expected = 'applied', extra = {}) => {
    const result = await request(`/v1/stores/${storeId}/commands`, { clientCommandId: randomUUID(), baseCursor: 0, command, ...extra }, token, { 'x-pos-sync-version': '2' });
    assert.equal(result.status, 201, JSON.stringify(result.value));
    assert.equal(result.value.status, expected, JSON.stringify(result.value));
    return result.value;
  };
  const productVersion = async (id) => (await db.query('SELECT record_version FROM products WHERE id=$1', [id])).rows[0].record_version;
  const unit = (id, name, multiplier, price, isBase = false) => ({ id, name, symbol: name, multiplierBaseUnits: multiplier,
    quantityStep: isBase ? 1 : 0.001, canSell: true, canRestock: true, allowAmountPricing: !isBase,
    sellingPrice: price, costPrice: Math.round(price / 2), isBase, isActive: true });
  const rice = randomUUID(), gram = randomUUID(), kilo = randomUUID();
  await command({ type: 'saveProduct', expectedVersion: null, payload: {
    id: rice, name: 'QA Rice', category: 'QA', costPrice: 3000, sellingPrice: 6000, stockQuantity: 10,
    unit: 'kg', soldByWeight: true, quantityStep: 0.001, lowStockThreshold: 1, isQuickItem: true,
    baseUnit: 'g', stockBaseQuantity: 10000, lowStockBaseThreshold: 1000,
    defaultSaleUnitId: kilo, defaultRestockUnitId: kilo, displayUnitId: kilo,
    units: [unit(gram, 'g', 1, 6, true), unit(kilo, 'kg', 1000, 6000)],
  } });
  const customerName = `QA Credit ${randomUUID().slice(0, 8)}`;
  const customer = await command({ type: 'createCustomer', payload: { name: customerName } });
  const customerId = customer.customerId;
  assert.ok(customerId);
  async function sale(productId, productUnitId, quantity, paymentMethod = 'cash', customerId = null) {
    return command({ type: 'completeSale', payload: { saleId: randomUUID(), transactionNumber: `FQA-${randomUUID().slice(0, 12)}`,
      occurredAt: new Date().toISOString(), paymentMethod, cashReceived: paymentMethod === 'cash' ? 50000 : null, customerId,
      cart: [{ productId, productUnitId, inputQuantity: quantity, quantity, expectedVersion: await productVersion(productId) }],
    } });
  }
  await sale(rice, kilo, 0.25);
  await sale(rice, kilo, 0.5, 'utang', customerId);
  await command({ type: 'recordUtangPayment', payload: { customerId, amount: 3500, note: 'QA credit' } });
  const balance = await db.query("SELECT SUM(CASE WHEN kind='payment' THEN -amount ELSE amount END)::int AS balance FROM utang_entries WHERE customer_id=$1", [customerId]);
  assert.equal(balance.rows[0].balance, -500);
  await command({ type: 'receiveStock', payload: { productId: rice, productUnitId: kilo, inputQuantity: 2 } });
  assert.equal(Number((await db.query('SELECT stock_base_quantity FROM products WHERE id=$1', [rice])).rows[0].stock_base_quantity), 11250);
  pass('weighted cash sale, utang purchase, overpayment credit, canonical restock');

  const bulk = randomUUID(), piece = randomUUID(), box = randomUUID();
  await command({ type: 'saveProduct', payload: { id: bulk, name: 'QA Bulk item', category: 'QA', costPrice: 250, sellingPrice: 500,
    stockQuantity: 48, unit: 'piece', quantityStep: 1, lowStockThreshold: 2, isQuickItem: true,
    baseUnit: 'piece', stockBaseQuantity: 48, defaultSaleUnitId: piece, defaultRestockUnitId: box, displayUnitId: piece,
    units: [unit(piece, 'piece', 1, 500, true), { ...unit(box, 'case', 24, 12000), quantityStep: 1 }],
  } });
  await sale(bulk, box, 1);
  await command({ type: 'receiveStock', payload: { productId: bulk, productUnitId: box, inputQuantity: 1 } });
  await command({ type: 'countStock', payload: { productId: bulk, productUnitId: piece, inputQuantity: 40, reason: 'physical_count', expectedVersion: await productVersion(bulk) } });
  await command({ type: 'adjustStockDelta', payload: { productId: bulk, productUnitId: piece, inputQuantity: -2, reason: 'damage' } });
  assert.equal(Number((await db.query('SELECT stock_base_quantity FROM products WHERE id=$1', [bulk])).rows[0].stock_base_quantity), 38);
  await command({ type: 'recordExpense', payload: { category: 'QA', description: 'QA electricity', amount: 500, occurredAt: new Date().toISOString() } });
  pass('bulk-unit sale, receipt, physical count, adjustment, expense');

  const metrics = await request('/v1/metrics'); assert.equal(metrics.status, 403);
  assert.equal((await request('/v1/metrics', undefined, undefined, { 'x-metrics-token': process.env.METRICS_TOKEN })).status, 200);
  const health = await request('/health/ready'); assert.equal(health.status, 200);
  assert.equal(health.headers.get('x-powered-by'), null); assert.ok(health.headers.get('x-content-type-options'));
  const cors = await request('/health/live', undefined, undefined, { origin: 'https://evil.example' });
  assert.equal(cors.headers.get('access-control-allow-origin'), null);
  assert.equal((await request('/v1/auth/login', { junk: 'x'.repeat(270000) })).status, 413);
  assert.throws(() => configModule.validateProductionConfig({ NODE_ENV: 'production' }), /Invalid production configuration/);
  pass('metrics authorization, readiness, security headers, CORS, parser limits, fail-closed configuration');

  app = await NestFactory.createApplicationContext(appModule.AppModule, { logger: ['error', 'warn'] });
  const backups = app.get(backupModule.BackupsService);
  const restore = app.get(restoreModule.BackupRestoreService);
  const data = app.get(dataModule.StoreDataService);
  const database = app.get(databaseModule.DatabaseService);
  // Force a concurrent committed change between snapshot reads to prove backup isolation.
  const originalTransaction = database.transaction.bind(database);
  let injected = false;
  database.transaction = (work) => originalTransaction(async (client) => {
    const originalQuery = client.query.bind(client);
    client.query = async (sql, values) => {
      const result = await originalQuery(sql, values);
      if (!injected && typeof sql === 'string' && sql.startsWith('SELECT * FROM products WHERE')) {
        injected = true;
        await db.query('BEGIN');
        await db.query("UPDATE products SET name='Concurrent rice' WHERE id=$1", [rice]);
        await db.query("UPDATE customers SET name='Concurrent customer' WHERE id=$1", [customerId]);
        await data.createSyncEvent(db, storeId, 'customer');
        await db.query('COMMIT');
      }
      return result;
    };
    try { return await work(client); } finally { client.query = originalQuery; }
  });
  const injectedTransaction = database.transaction;
  try { await backups.create(principal); } finally { database.transaction = originalTransaction; }
  assert.ok(injected);
  let backupId = (await db.query("SELECT id FROM backups WHERE store_id=$1 AND status='complete' ORDER BY created_at DESC LIMIT 1", [storeId])).rows[0].id;
  const loaded = await backups.loadForRestore(storeId, backupId);
  assert.equal(loaded.snapshot.products.find(p => p.id === rice).name, 'QA Rice');
  assert.equal(loaded.snapshot.customers.find(c => c.id === customerId).name, customerName);
  pass('backup remains transactionally consistent during concurrent writes');

  await db.query("UPDATE products SET name='QA Rice' WHERE id=$1", [rice]);
  await db.query('UPDATE customers SET name=$2 WHERE id=$1', [customerId, customerName]);
  const cursorBefore = await data.currentCursor(storeId);
  injected = false;
  database.transaction = injectedTransaction;
  let coherent;
  try { coherent = await data.loadSyncSnapshot(storeId, true); } finally { database.transaction = originalTransaction; }
  assert.ok(injected);
  assert.equal(coherent.snapshot.products.find(p => p.id === rice).name, 'QA Rice');
  assert.equal(coherent.snapshot.customers.find(c => c.id === customerId).name, customerName);
  assert.equal(coherent.cursor, cursorBefore);
  assert.ok((await data.currentCursor(storeId)) > coherent.cursor);
  pass('bootstrap snapshot and cursor share one committed state during concurrent writes');

  // Snapshot canonical history and restore after modifying live data.
  await db.query("UPDATE products SET name='QA Rice' WHERE id=$1", [rice]);
  await db.query('UPDATE customers SET name=$2 WHERE id=$1', [customerId, customerName]);
  await backups.create(principal);
  backupId = (await db.query("SELECT id FROM backups WHERE store_id=$1 AND status='complete' ORDER BY created_at DESC LIMIT 1", [storeId])).rows[0].id;
  const before = await data.loadSnapshot(storeId, { includeInactiveUnits: true });
  const dry = await restore.restore(storeId, backupId, { dryRun: true }); assert.equal(dry.dryRun, true);
  await db.query('UPDATE products SET stock_base_quantity=1, stock_quantity=0.001 WHERE id=$1', [rice]);
  const restored = await restore.restore(storeId, backupId, { dryRun: false }); assert.equal(restored.recoveringAttachments, 0);
  const after = await data.loadSnapshot(storeId, { includeInactiveUnits: true });
  const sorted = (rows) => [...rows].sort((a,b) => a.id.localeCompare(b.id));
  for (const key of ['products', 'productUnits', 'sales', 'saleItems', 'inventoryMovements', 'customers', 'utangEntries', 'expenses', 'qrPayments']) {
    assert.deepEqual(sorted(after[key] ?? []), sorted(before[key] ?? []), `Restore must preserve every field in ${key}`);
  }
  assert.equal((await db.query('SELECT maintenance_mode FROM stores WHERE id=$1', [storeId])).rows[0].maintenance_mode, false);
  backupId = (await db.query("SELECT id FROM backups WHERE store_id=$1 AND status='complete' ORDER BY created_at DESC LIMIT 1", [storeId])).rows[0].id;
  await assert.rejects(() => backups.loadForRestore(randomUUID(), backupId));
  const checksum = (await db.query('SELECT checksum_sha256 FROM backups WHERE id=$1', [backupId])).rows[0].checksum_sha256;
  await db.query("UPDATE backups SET checksum_sha256=$2 WHERE id=$1", [backupId, '0'.repeat(64)]);
  await assert.rejects(() => restore.restore(storeId, backupId, { dryRun: false }), /checksum/);
  await db.query('UPDATE backups SET checksum_sha256=$2 WHERE id=$1', [backupId, checksum]);
  assert.deepEqual(sorted((await data.loadSnapshot(storeId)).products), sorted(after.products));
  pass('encrypted backup dry-run and full restore preserve all operational fields; wrong-store/corrupt backup rejected without mutation');

  await app.get(objectModule.ObjectOperationsService).reconcile();
  const pending = await db.query("SELECT COUNT(*)::int AS count FROM object_operations WHERE store_id=$1 AND status <> 'complete'", [storeId]);
  assert.equal(pending.rows[0].count, 0);
  pass('object reconciliation drains tracked restore/delete operations');
  const currentCursor = await data.currentCursor(storeId);
  for (let i=0;i<502;i++) await database.transaction(client => data.createSyncEvent(client, storeId, 'customer'));
  const first = await data.loadDelta(storeId, currentCursor); assert.equal(first.changes.length,500); assert.equal(first.hasMore,true);
  const second = await data.loadDelta(storeId, first.cursor); assert.equal(second.changes.length,2); assert.equal(second.hasMore,false);
  await db.query("UPDATE entity_changes SET changed_at=now()-interval '31 days' WHERE store_id=$1", [storeId]);
  await app.get(retentionModule.RetentionService).prune();
  const stale = await request(`/v1/stores/${storeId}/sync?cursor=${currentCursor}`, undefined, token, { 'x-pos-sync-version':'2' });
  assert.equal(stale.status,409); assert.equal(stale.value.code,'full_resync_required');
  pass('cursor pagination and retained-window full resync');
  console.log(JSON.stringify({ ok:true, checks, storeId, backupId }, null, 2));
} finally { if(app) await app.close(); await db.end(); }
