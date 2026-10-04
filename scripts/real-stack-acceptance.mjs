import pg from 'pg';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';

const apiUrl = process.env.AUDIT_API_URL ?? 'http://127.0.0.1:4400';
const databaseUrl = process.env.AUDIT_DATABASE_URL;
if (!databaseUrl || !new URL(databaseUrl).pathname.includes('audit')) {
  throw new Error('AUDIT_DATABASE_URL must name an explicitly disposable audit database');
}

async function request(path, init = {}) {
  const response = await fetch(`${apiUrl}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null,
    cookie: response.headers.get('set-cookie')?.split(';')[0] ?? '',
  };
}

async function rawRequest(path, init = {}) {
  const response = await fetch(`${apiUrl}${path}`, init);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();
try {
  const existing = await client.query('SELECT COUNT(*)::int AS count FROM stores');
  assert.equal(existing.rows[0].count, 0, 'audit database must start empty');

  assert.equal((await request('/health/live')).status, 200);
  assert.equal((await request('/health/ready')).status, 200);
  assert.equal((await request(`/v1/stores/${randomUUID()}/bootstrap`)).status, 401);

  const deviceA = randomUUID();
  const deviceB = randomUUID();
  const candidates = [
    { storeName: 'Audit Store A', displayName: 'Audit Owner A', email: 'audit-a@example.invalid', password: 'AuditPassword123!', deviceId: deviceA, deviceName: 'Audit device A' },
    { storeName: 'Audit Store B', displayName: 'Audit Owner B', email: 'audit-b@example.invalid', password: 'AuditPassword456!', deviceId: deviceB, deviceName: 'Audit device B' },
  ];
  const setupResults = await Promise.all(candidates.map((body) => request('/v1/auth/setup-owner', { method: 'POST', body: JSON.stringify(body) })));
  assert.deepEqual(setupResults.map((result) => result.status).sort(), [201, 409], 'exactly one concurrent setup must commit');
  const winnerIndex = setupResults.findIndex((result) => result.status === 201);
  const credentials = candidates[winnerIndex];
  const setup = setupResults[winnerIndex];
  const storeId = setup.body.store.id;
  let tokenA = setup.body.token;
  assert.ok(setup.cookie.startsWith('gma_pos_refresh='));

  const crossStore = await request(`/v1/stores/${randomUUID()}/bootstrap`, { headers: { authorization: `Bearer ${tokenA}` } });
  assert.equal(crossStore.status, 403);

  const refresh = await request('/v1/auth/refresh', { method: 'POST', headers: { cookie: setup.cookie } });
  assert.equal(refresh.status, 200);
  assert.notEqual(refresh.body.token, tokenA);
  tokenA = refresh.body.token;
  assert.equal((await request(`/v1/stores/${storeId}/bootstrap`, { headers: { authorization: `Bearer ${tokenA}` } })).status, 200);

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const response = await request('/v1/auth/login', { method: 'POST', body: JSON.stringify({
      email: 'rate-limit@example.invalid', password: 'wrong-password', deviceId: randomUUID(), deviceName: 'Abuse probe',
    }) });
    if (attempt < 5) assert.equal(response.status, 401);
    else assert.equal(response.status, 429);
  }

  const unknownDeviceId = randomUUID();
  const challenge = await request('/v1/auth/login', { method: 'POST', body: JSON.stringify({
    email: credentials.email, password: credentials.password, deviceId: unknownDeviceId, deviceName: 'Audit device 2',
  }) });
  assert.equal(challenge.status, 428);
  assert.equal(challenge.body.code, 'device_enrollment_required');
  const decision = await request(`/v1/auth/device-enrollments/${challenge.body.challengeId}/decision`, {
    method: 'POST', headers: { authorization: `Bearer ${tokenA}` }, body: JSON.stringify({ approve: true }),
  });
  assert.equal(decision.status, 201);
  const loginB = await request('/v1/auth/login', { method: 'POST', body: JSON.stringify({
    email: credentials.email, password: credentials.password, deviceId: unknownDeviceId, deviceName: 'Audit device 2',
  }) });
  assert.equal(loginB.status, 200);
  const tokenB = loginB.body.token;
  assert.equal((await request(`/v1/stores/${storeId}/bootstrap`, { headers: { authorization: `Bearer ${tokenB}` } })).status, 200);

  const productId = randomUUID();
  const command = (token, commandBody) => request(`/v1/stores/${storeId}/commands`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'x-pos-sync-version': '2' },
    body: JSON.stringify({ clientCommandId: randomUUID(), baseCursor: 0, occurredAt: new Date().toISOString(), command: commandBody }),
  });
  const saved = await command(tokenA, { type: 'saveProduct', expectedVersion: null, payload: {
    id: productId, barcode: 'AUDIT-001', imageRevision: null, name: 'Audit item', category: 'Audit',
    costPrice: 500, sellingPrice: 700, stockQuantity: 20, unit: 'piece', soldByWeight: false,
    quantityStep: 1, lowStockThreshold: 2, isQuickItem: true, isActive: true,
  } });
  assert.equal(saved.status, 201);
  assert.equal(saved.body.status, 'applied');
  assert.equal(saved.body.snapshot, undefined, 'sync-v2 commands must not return full history');
  const initialDelta = await request(`/v1/stores/${storeId}/sync?cursor=0`, {
    headers: { authorization: `Bearer ${tokenA}`, 'x-pos-sync-version': '2' },
  });
  assert.equal(initialDelta.status, 200);
  assert.ok(initialDelta.body.patch.products.some((product) => product.id === productId));
  assert.equal(initialDelta.body.fullSnapshot, undefined);

  const imageRevision = randomUUID();
  const savedWithImage = await command(tokenA, { type: 'saveProduct', expectedVersion: 1, payload: {
    id: productId, barcode: 'AUDIT-001', imageRevision, name: 'Audit item', category: 'Audit',
    costPrice: 500, sellingPrice: 700, stockQuantity: 20, unit: 'piece', soldByWeight: false,
    quantityStep: 1, lowStockThreshold: 2, isQuickItem: true, isActive: true,
  } });
  assert.equal(savedWithImage.body.status, 'applied');
  const image = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#336699' } }).jpeg().toBuffer();
  const imagePath = `/v1/stores/${storeId}/products/${productId}/images/${imageRevision}`;
  assert.equal((await rawRequest(imagePath, {
    method: 'PUT', headers: { authorization: `Bearer ${tokenA}`, 'content-type': 'image/jpeg' }, body: image,
  })).status, 200);
  assert.equal((await rawRequest(imagePath, {
    method: 'PUT', headers: { authorization: `Bearer ${tokenA}`, 'content-type': 'image/jpeg' }, body: Buffer.from([0xff, 0xd8, 0xff]),
  })).status, 400);

  const createdCashier = await request(`/v1/stores/${storeId}/staff`, {
    method: 'POST', headers: { authorization: `Bearer ${tokenA}` },
    body: JSON.stringify({ role: 'cashier', displayName: 'Audit Cashier', staffCode: 'AUDIT-CASH', pin: '2468' }),
  });
  assert.equal(createdCashier.status, 201);
  const cashierDevice = randomUUID();
  const cashierChallenge = await request('/v1/auth/cashier-login', { method: 'POST', body: JSON.stringify({
    storeId, staffCode: 'AUDIT-CASH', pin: '2468', deviceId: cashierDevice, deviceName: 'Cashier audit device',
  }) });
  assert.equal(cashierChallenge.status, 428);
  assert.equal((await request(`/v1/auth/device-enrollments/${cashierChallenge.body.challengeId}/decision`, {
    method: 'POST', headers: { authorization: `Bearer ${tokenA}` }, body: JSON.stringify({ approve: true }),
  })).status, 201);
  const cashierLogin = await request('/v1/auth/cashier-login', { method: 'POST', body: JSON.stringify({
    storeId, staffCode: 'AUDIT-CASH', pin: '2468', deviceId: cashierDevice, deviceName: 'Cashier audit device',
  }) });
  assert.equal(cashierLogin.status, 200);
  assert.equal((await request(`/v1/stores/${storeId}/bootstrap`, { headers: { authorization: `Bearer ${cashierLogin.body.token}` } })).status, 200);
  assert.equal((await rawRequest(imagePath, {
    method: 'PUT', headers: { authorization: `Bearer ${cashierLogin.body.token}`, 'content-type': 'image/jpeg' }, body: image,
  })).status, 403);

  const duplicateCommand = {
    clientCommandId: randomUUID(), baseCursor: 0, occurredAt: new Date().toISOString(),
    command: { type: 'createCustomer', payload: { name: 'Idempotent customer' } },
  };
  const duplicateResults = await Promise.all([tokenA, tokenA].map((token) => request(`/v1/stores/${storeId}/commands`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'x-pos-sync-version': '2' }, body: JSON.stringify(duplicateCommand),
  })));
  assert.deepEqual(duplicateResults.map((result) => result.body.status), ['applied', 'applied']);
  assert.equal((await client.query("SELECT COUNT(*)::int AS count FROM customers WHERE store_id = $1 AND name = 'Idempotent customer'", [storeId])).rows[0].count, 1);

  const makeSale = (token, suffix, paymentMethod = 'cash', reference = null, expectedVersion = 1) => command(token, {
    type: 'completeSale', payload: {
      saleId: randomUUID(), transactionNumber: `AUDIT-${suffix}`, occurredAt: new Date().toISOString(),
      paymentMethod, cashReceived: paymentMethod === 'cash' ? 20_000 : null, customerId: null,
      qrPayment: paymentMethod === 'qrph' ? { id: randomUUID(), reference, confirmationSource: 'merchant_notification' } : null,
      cart: [{ productId, quantity: 12, expectedVersion }],
    },
  });
  const concurrent = await Promise.all([makeSale(tokenA, 'RACE-A', 'cash', null, 2), makeSale(tokenB, 'RACE-B', 'cash', null, 2)]);
  assert.deepEqual(concurrent.map((result) => result.body.status).sort(), ['applied', 'conflict']);
  const currentProduct = (await client.query(
    'SELECT stock_quantity, record_version FROM products WHERE store_id = $1 AND id = $2',
    [storeId, productId],
  )).rows[0];
  assert.equal(currentProduct.stock_quantity, 8);

  const qr1 = await command(tokenA, { type: 'completeSale', payload: {
    saleId: randomUUID(), transactionNumber: 'AUDIT-QR-1', occurredAt: new Date().toISOString(), paymentMethod: 'qrph', cashReceived: null, customerId: null,
    qrPayment: { id: randomUUID(), reference: ' REF-123 ', confirmationSource: 'merchant_notification' },
    cart: [{ productId, quantity: 1, expectedVersion: currentProduct.record_version }],
  } });
  assert.equal(qr1.body.qrPaymentStatus, 'merchant_confirmed');
  const nextProduct = (await client.query(
    'SELECT record_version FROM products WHERE store_id = $1 AND id = $2',
    [storeId, productId],
  )).rows[0];
  const qr2 = await command(tokenB, { type: 'completeSale', payload: {
    saleId: randomUUID(), transactionNumber: 'AUDIT-QR-2', occurredAt: new Date().toISOString(), paymentMethod: 'qrph', cashReceived: null, customerId: null,
    qrPayment: { id: randomUUID(), reference: 'ref 123', confirmationSource: 'merchant_notification' },
    cart: [{ productId, quantity: 1, expectedVersion: nextProduct.record_version }],
  } });
  assert.equal(qr2.body.qrPaymentStatus, 'pending_review');
  const duplicateQr = await client.query('SELECT attention_reason FROM qr_payments WHERE store_id = $1 AND sale_id = $2', [storeId, qr2.body.saleId]);
  assert.equal(duplicateQr.rows[0].attention_reason, 'duplicate_reference');

  const backup = await request(`/v1/stores/${storeId}/backups`, { method: 'POST', headers: { authorization: `Bearer ${tokenA}` }, body: '{}' });
  assert.equal(backup.status, 201);
  assert.equal(backup.body.backupCount, 1);
  const backupRow = await client.query("SELECT id, status, format_version, encryption_key_id FROM backups WHERE store_id = $1 ORDER BY created_at DESC LIMIT 1", [storeId]);
  assert.deepEqual(backupRow.rows[0], { id: backupRow.rows[0].id, status: 'complete', format_version: 1, encryption_key_id: 'audit' });
  const imageAttachment = await client.query('SELECT byte_length FROM product_images WHERE store_id = $1 AND product_id = $2', [storeId, productId]);
  assert.ok(Number(imageAttachment.rows[0]?.byte_length) > 0);

  const logout = await request('/v1/auth/logout', { method: 'POST', headers: { authorization: `Bearer ${tokenA}`, cookie: refresh.cookie } });
  assert.equal(logout.status, 200);
  assert.equal((await request('/v1/auth/me', { headers: { authorization: `Bearer ${tokenA}` } })).status, 401);

  console.log(JSON.stringify({ ok: true, storeId, backupId: backupRow.rows[0].id, productId, imageRevision, assertions: 40 }));
} finally {
  await client.end();
}
