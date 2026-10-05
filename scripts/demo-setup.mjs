// Explicitly invoked, resumable setup. Only uses the existing public API.
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const api = process.env.DEMO_API_URL?.replace(/\/$/, '');
if (!api || process.env.DEMO_CONFIRM !== 'CREATE_SAMPLE_STORE') {
  throw new Error('Set DEMO_API_URL and DEMO_CONFIRM=CREATE_SAMPLE_STORE to explicitly create fictional demo data.');
}
const origin = new URL(api);
if (origin.origin !== api || (origin.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(origin.hostname))) {
  throw new Error('DEMO_API_URL must be an HTTPS origin, or localhost for testing.');
}
const adminEmail = process.env.SUPERADMIN_EMAIL;
const adminPassword = process.env.SUPERADMIN_PASSWORD;
if (!adminEmail || !adminPassword) throw new Error('SUPERADMIN_EMAIL and SUPERADMIN_PASSWORD are required; they are never printed or saved.');
const stateDir = path.resolve(process.env.DEMO_STATE_DIR || '.demo');
await mkdir(stateDir, { recursive: true, mode: 0o700 });
const stateFile = path.join(stateDir, 'setup-state.json');
let state;
try { state = JSON.parse(await readFile(stateFile, 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
state ??= {
  api, storeName: 'Bayanihan Academic Demo', ownerEmail: 'demo-owner@example.invalid',
  ownerPassword: randomBytes(18).toString('base64url'), cashierCode: 'DEMO-CASH',
  cashierPin: String(100000 + randomBytes(4).readUInt32BE() % 900000),
  adminDeviceId: randomUUID(), ownerDeviceId: randomUUID(), commands: {},
};
if (state.api !== api) throw new Error('This setup journal belongs to another API. Use a separate DEMO_STATE_DIR.');
async function saveState() {
  await writeFile(`${stateFile}.tmp`, JSON.stringify(state, null, 2), { mode: 0o600 });
  await rename(`${stateFile}.tmp`, stateFile);
}
await saveState();

async function request(route, { body, token, ...options } = {}) {
  const response = await fetch(`${api}${route}`, {
    method: body === undefined ? 'GET' : 'POST', ...options,
    redirect: 'error', signal: AbortSignal.timeout(120_000),
    headers: { 'content-type': 'application/json', 'x-pos-sync-version': '2', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let value;
  try { value = await response.json(); } catch { throw new Error(`API returned non-JSON for ${route}. Wake the server and rerun setup.`); }
  if (!response.ok) {
    // Do not log bodies, which could contain credentials or session tokens.
    const error = new Error(`API request ${route} failed (${response.status}). Setup stopped; rerun with the same journal after fixing the cause.`);
    error.status = response.status;
    error.challengeId = value.code === 'device_enrollment_required' ? value.challengeId : undefined;
    throw error;
  }
  return value;
}

const admin = await request('/v1/auth/login', { body: {
  email: adminEmail, password: adminPassword, deviceId: state.adminDeviceId, deviceName: 'Demo setup administrator',
} });
if (admin.user.role !== 'superadmin') throw new Error('Setup requires a superadmin account.');
const { stores } = await request('/v1/superadmin/stores', { token: admin.token });
const matches = stores.filter((store) => store.name === state.storeName);
if (matches.length > 1) throw new Error('Multiple demo stores found; resolve this before rerunning setup.');
let store = state.storeId ? stores.find((candidate) => candidate.id === state.storeId) : matches[0];
if (state.storeId && !store) throw new Error('The journal store no longer exists; use a new journal for a new demo.');
if (!store) {
  ({ store } = await request('/v1/superadmin/stores', { token: admin.token, body: {
    storeName: state.storeName, ownerDisplayName: 'Demo Owner', ownerEmail: state.ownerEmail, ownerPassword: state.ownerPassword,
  } }));
}
state.storeId = store.id;
await saveState();
const details = await request(`/v1/superadmin/stores/${store.id}`, { token: admin.token });
if (!details.staff.some((staff) => staff.email === state.ownerEmail && staff.role === 'owner')) {
  throw new Error('The existing store does not match the journal owner. Refusing to modify it.');
}
const ownerLogin = () => request('/v1/auth/login', { body: {
  email: state.ownerEmail, password: state.ownerPassword, deviceId: state.ownerDeviceId, deviceName: 'Demo data setup',
} });
let owner;
try { owner = await ownerLogin(); }
catch (error) {
  if (error.status !== 428 || !error.challengeId) throw error;
  await request(`/v1/auth/device-enrollments/${error.challengeId}/decision`, { token: admin.token, body: { approve: true } });
  owner = await ownerLogin();
}
if (owner.store?.id !== store.id) throw new Error('Owner session is linked to an unexpected store.');
const base = `/v1/stores/${store.id}`;
const snapshot = () => request(`${base}/bootstrap`, { token: owner.token });
await snapshot(); // Marks this device as bootstrapped before commands are accepted.
const staff = await request(`${base}/staff`, { token: owner.token });
if (!staff.staff.some((member) => member.staffCode === state.cashierCode)) {
  await request(`${base}/staff`, { token: owner.token, body: {
    role: 'cashier', displayName: 'Demo Cashier', staffCode: state.cashierCode, pin: state.cashierPin,
  } });
}

async function command(label, build) {
  if (state.commands[label]?.result) return state.commands[label].result;
  if (!state.commands[label]) {
    const current = await snapshot();
    state.commands[label] = { request: {
      clientCommandId: randomUUID(), baseCursor: current.cursor ?? 0,
      occurredAt: new Date().toISOString(), command: build(current.snapshot),
    } };
    await saveState(); // Save the exact request BEFORE sending: reruns reuse its idempotency key.
  }
  const result = await request(`${base}/commands`, { token: owner.token, body: state.commands[label].request });
  if (result.status !== 'applied') throw new Error(`Demo command ${label} conflicted. Stop and inspect the demo; do not delete the setup journal.`);
  state.commands[label].result = result;
  await saveState();
  return result;
}

const products = [
  ['Rice 1 kg', 'Essentials', 5500], ['Egg', 'Essentials', 900], ['Sardines', 'Canned goods', 2500],
  ['Corned beef', 'Canned goods', 3800], ['Instant noodles', 'Pantry', 1400], ['Soy sauce sachet', 'Pantry', 800],
  ['Vinegar sachet', 'Pantry', 700], ['Cooking oil pouch', 'Pantry', 1800], ['Sugar 250 g', 'Pantry', 2400],
  ['Salt pack', 'Pantry', 1000], ['Coffee sachet', 'Drinks', 1000], ['Milk sachet', 'Drinks', 1200],
  ['Bottled water', 'Drinks', 1500], ['Cola bottle', 'Drinks', 2000], ['Juice box', 'Drinks', 1400],
  ['Crackers', 'Snacks', 800], ['Biscuit pack', 'Snacks', 1000], ['Chips', 'Snacks', 1500],
  ['Laundry soap', 'Household', 1800], ['Shampoo sachet', 'Personal care', 800],
];
for (const [index, [name, category, sellingPrice]] of products.entries()) {
  await command(`product-${index}`, () => ({ type: 'saveProduct', expectedVersion: null, payload: {
    id: randomUUID(), barcode: `DEMO-${String(index + 1).padStart(3, '0')}`, name, category,
    costPrice: Math.round(sellingPrice * 0.75), sellingPrice, stockQuantity: index === 19 ? 3 : 50,
    unit: 'piece', soldByWeight: false, quantityStep: 1, lowStockThreshold: 5, isQuickItem: index < 8, isActive: true,
  } }));
}
const customer = await command('customer', () => ({ type: 'createCustomer', payload: { name: 'Sample Customer', notes: 'Fictional academic demo customer' } }));
for (const [index, method] of ['cash', 'utang', 'qrph'].entries()) {
  await command(`sale-${method}`, (current) => {
    const product = current.products.find((item) => item.barcode === `DEMO-${String(index + 1).padStart(3, '0')}`);
    if (!product) throw new Error('Demo product missing from the store snapshot.');
    return { type: 'completeSale', payload: {
      saleId: randomUUID(), transactionNumber: `DEMO-${method.toUpperCase()}-001`, occurredAt: new Date().toISOString(),
      paymentMethod: method, cashReceived: method === 'cash' ? 10000 : null,
      customerId: method === 'utang' ? customer.customerId : null,
      qrPayment: method === 'qrph' ? { id: randomUUID(), reference: 'FICTIONAL-DEMO-QR-001', confirmationSource: 'merchant_notification' } : null,
      cart: [{ productId: product.id, quantity: 1, expectedVersion: product.recordVersion }],
    } };
  });
}
await request('/v1/auth/logout', { token: owner.token, body: {} });
await request('/v1/auth/logout', { token: admin.token, body: {} });
await writeFile(path.join(stateDir, 'demo-access.txt'), [
  'FICTIONAL ACADEMIC DEMO — do not use for real payments', `Website/API: ${api}`, `Store: ${store.name}`, `Store ID: ${store.id}`,
  `Owner email: ${state.ownerEmail}`, `Owner password: ${state.ownerPassword}`,
  `Cashier code: ${state.cashierCode}`, `Cashier PIN: ${state.cashierPin}`,
  'A superadmin must approve the first owner browser. Then that owner can approve other demo browsers.',
  'Sign in as owner on a browser first to associate it with the store and reveal the Cashier tab.',
  'Keep setup-state.json to safely resume setup; do not commit or publicly share it.', '',
].join('\n'), { mode: 0o600 });
console.log(`Demo ready: 20 products, 1 customer, cash/utang/QR sample sales. Credentials saved privately to ${path.join(stateDir, 'demo-access.txt')}.`);
