// Run after building the website with the local proxy settings in academic-demo.md.
// Uses the explicitly disposable audit database; never a hosted/demo/store database.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

const database = process.env.AUDIT_DATABASE_URL;
assert.ok(database && new URL(database).pathname.includes('audit'), 'An explicitly disposable AUDIT_DATABASE_URL is required');
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(database).hostname), 'Only a local disposable database is allowed');
const dir = await mkdtemp(path.join(tmpdir(), 'pos-demo-test-'));
const api = 'http://127.0.0.1:4400';
const web = 'http://127.0.0.1:3400';
const env = { ...process.env, NODE_ENV: 'development', PORT: '4400',
  DATABASE_URL: database, CORS_ORIGIN: web,
  JWT_SECRET: randomBytes(32).toString('hex'), METRICS_TOKEN: randomBytes(24).toString('hex'),
  SUPERADMIN_EMAIL: 'demo-test-admin@example.invalid', SUPERADMIN_PASSWORD: randomBytes(24).toString('base64url'),
  S3_ENDPOINT: 'http://127.0.0.1:59000', S3_REGION: 'us-east-1', S3_BUCKET: 'gma-pos-audit',
  S3_ACCESS_KEY: 'audit-access', S3_SECRET_KEY: 'audit-secret-key', S3_FORCE_PATH_STYLE: 'true',
  BACKUP_ENCRYPTION_ACTIVE_KEY_ID: 'demo-test', BACKUP_ENCRYPTION_KEYS_JSON: JSON.stringify({ 'demo-test': randomBytes(32).toString('base64') }),
  BACKUP_MAX_BYTES: '41943040', DEMO_API_URL: web, DEMO_CONFIRM: 'CREATE_SAMPLE_STORE', DEMO_STATE_DIR: dir,
};
const children = [];
const log = await open(path.join(dir, 'services.log'), 'a', 0o600);
function launch(file, args, overrides = {}) {
  const child = spawn(file, args, { env: { ...env, ...overrides }, stdio: ['ignore', log.fd, log.fd] });
  children.push(child);
  return child;
}
const startApi = () => launch(process.execPath, ['apps/api/dist/main.js']);
async function waitFor(url) {
  for (let attempt = 0; attempt < 40; attempt++) {
    try { if ((await fetch(url, { signal: AbortSignal.timeout(2000) })).ok) return; } catch { /* still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Service did not become ready: ${url}. Inspect ${path.join(dir, 'services.log')}`);
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => { child.once('exit', resolve); child.kill('SIGTERM'); });
}
async function seed() {
  await new Promise((resolve, reject) => {
    const child = launch(process.execPath, ['scripts/demo-setup.mjs']);
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`Seed failed (${code}); inspect ${path.join(dir, 'services.log')}`)));
  });
}
async function request(route, init = {}) {
  const response = await fetch(`${web}${route}`, init);
  assert.ok(response.ok, `${init.method ?? 'GET'} ${route} returned ${response.status}`);
  assert.match(response.headers.get('cache-control') ?? '', /no-store/);
  return response;
}

try {
  let server = startApi();
  launch(process.execPath, ['node_modules/next/dist/bin/next', 'start', 'apps/web', '-p', '3400'], { NODE_ENV: 'production' });
  await waitFor(`${api}/health/ready`);
  await waitFor(web);
  await request('/v1/auth/setup-status');
  await seed();
  await seed();
  const state = JSON.parse(await readFile(path.join(dir, 'setup-state.json'), 'utf8'));
  const login = async () => request('/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
    email: state.ownerEmail, password: state.ownerPassword, deviceId: state.ownerDeviceId, deviceName: 'Demo acceptance',
  }) });
  const response = await login();
  const cookie = response.headers.get('set-cookie');
  assert.match(cookie, /gma_pos_refresh=/);
  assert.match(cookie, /Path=\/v1\/auth/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/i);
  const refreshed = await request('/v1/auth/refresh', { method: 'POST', headers: { cookie: cookie.split(';')[0] } });
  assert.notEqual(refreshed.headers.get('set-cookie'), cookie);
  let session = await refreshed.json();
  const headers = () => ({ authorization: `Bearer ${session.token}`, 'content-type': 'application/json', 'x-pos-sync-version': '2' });
  const base = `/v1/stores/${state.storeId}`;
  const snapshot = async () => (await request(`${base}/bootstrap`, { headers: headers() })).json();
  let data = await snapshot();
  assert.equal(data.snapshot.products.length, 20);
  assert.equal(data.snapshot.customers.length, 1);
  assert.equal(data.snapshot.sales.length, 3);
  assert.deepEqual(data.snapshot.sales.map((sale) => sale.paymentMethod).sort(), ['cash', 'qrph', 'utang']);
  assert.equal(data.snapshot.staff.filter((staff) => staff.role === 'cashier').length, 1);
  console.log('PASS sample setup rerun: one store, 20 products, one cashier, three distinct sales');
  console.log('PASS same-origin proxy: cookies, refresh rotation, authorization, JSON bodies, no-store headers');

  const product = data.snapshot.products[0];
  const revision = randomUUID();
  const payload = { ...product, imageRevision: revision };
  const command = { clientCommandId: randomUUID(), baseCursor: data.cursor,
    command: { type: 'saveProduct', expectedVersion: product.recordVersion, payload } };
  const result = await (await request(`${base}/commands`, { method: 'POST', headers: headers(), body: JSON.stringify(command) })).json();
  assert.equal(result.status, 'applied');
  const image = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#26765e' } }).jpeg().toBuffer();
  const imagePath = `${base}/products/${product.id}/images/${revision}`;
  await request(imagePath, { method: 'PUT', headers: { authorization: `Bearer ${session.token}`, 'content-type': 'image/jpeg' }, body: image });
  assert.ok((await (await request(imagePath, { headers: headers() })).arrayBuffer()).byteLength > 0);
  const qrPath = `${base}/payment-settings/qrph/${randomUUID()}`;
  await request(qrPath, { method: 'PUT', headers: { authorization: `Bearer ${session.token}`, 'content-type': 'image/jpeg' }, body: image });
  assert.ok((await (await request(qrPath, { headers: headers() })).arrayBuffer()).byteLength > 0);
  const backup = await (await request(`${base}/backups`, { method: 'POST', headers: headers() })).json();
  assert.ok(backup);
  console.log('PASS binary uploads and reads, fictional QR image, encrypted backup request');

  await stop(server);
  server = startApi();
  await waitFor(`${api}/health/ready`);
  session = await (await login()).json();
  data = await snapshot();
  assert.equal(data.snapshot.sales.length, 3);
  assert.ok((await (await request(imagePath, { headers: headers() })).arrayBuffer()).byteLength > 0);
  await request(imagePath, { method: 'DELETE', headers: headers() });
  await request(qrPath, { method: 'DELETE', headers: headers() });
  await request('/v1/auth/logout', { method: 'POST', headers: headers() });
  const denied = await fetch(`${web}${base}/bootstrap`, { headers: headers() });
  assert.equal(denied.status, 401);
  console.log('PASS API restart persistence, image deletion, logout revocation');
  console.log(`Local demo acceptance passed. Private test artifacts: ${dir}`);
} finally {
  await Promise.all(children.map(stop));
  await log.close();
}
