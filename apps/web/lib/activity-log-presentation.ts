import type { ActivityLog, PaymentMethod, Role } from '@gma/contracts';

export interface ActivityDetailItem {
  label: string;
  value: string;
}

export interface ActivityChangeItem {
  label: string;
  before: string;
  after: string;
}

export interface ActivityPresentation {
  details: ActivityDetailItem[];
  changes: ActivityChangeItem[];
  technical: ActivityDetailItem[];
}

interface FlatDetail {
  path: string;
  key: string;
  value: unknown;
}

const paymentLabels: Record<PaymentMethod, string> = {
  cash: 'Cash',
  qrph: 'QR Ph',
  gcash: 'GCash',
  maya: 'Maya',
  utang: 'Utang',
  other: 'Other',
};

const detailLabels: Record<string, string> = {
  amount: 'Amount',
  barcode: 'Barcode',
  byteLength: 'File size',
  category: 'Category',
  confirmationSource: 'Confirmation source',
  contentType: 'File type',
  costPrice: 'Cost price',
  credentialType: 'Credential changed',
  customerName: 'Customer',
  decision: 'Decision',
  description: 'Description',
  inputQuantity: 'Quantity entered',
  isActive: 'Status',
  itemCount: 'Items',
  method: 'Sign-in method',
  mode: 'Stock update',
  name: 'Name',
  newQuantity: 'New stock level',
  note: 'Note',
  occurredAt: 'Business date',
  ownerDisplayName: 'Store owner',
  paymentMethod: 'Payment method',
  products: 'Products imported',
  quantity: 'Quantity',
  reason: 'Reason',
  sellingPrice: 'Selling price',
  stockQuantity: 'Stock on hand',
  targetDisplayName: 'Staff member',
  targetRole: 'Role',
  total: 'Sale total',
  transactionNumber: 'Transaction number',
  unit: 'Unit',
  utangPurchase: 'Added to Utang',
  sales: 'Sales imported',
  customers: 'Customers imported',
  expenses: 'Expenses imported',
};

const moneyKeys = new Set(['amount', 'cashReceived', 'costPrice', 'enteredAmount', 'sellingPrice', 'total']);
const dateKeys = new Set(['confirmedAt', 'createdAt', 'occurredAt', 'updatedAt']);
const technicalKeys = new Set([
  'byteLength', 'clientCommandId', 'deviceId', 'entityId', 'expectedVersion', 'productUnitId',
  'revision', 'schemaVersion', 'storeId',
]);

const actionFields: Record<string, string[]> = {
  'sale.completed': ['transactionNumber', 'total', 'paymentMethod', 'itemCount', 'utangPurchase'],
  'payment.qrph_verified': ['decision', 'note'],
  'payment.qrph_rejected': ['decision', 'note'],
  'inventory.adjusted': ['newQuantity', 'inputQuantity', 'quantity', 'mode', 'reason', 'note'],
  'inventory.restocked': ['inputQuantity', 'quantity', 'mode', 'note'],
  'inventory.counted': ['inputQuantity', 'reason', 'note'],
  'product.created': ['after.name', 'after.category', 'after.barcode', 'after.costPrice', 'after.sellingPrice', 'after.stockQuantity', 'after.unit', 'after.isActive', 'name', 'category'],
  'product.updated': ['after.name', 'after.category', 'after.barcode', 'after.costPrice', 'after.sellingPrice', 'after.stockQuantity', 'after.unit', 'after.isActive', 'name', 'category'],
  'customer.created': ['name'],
  'customer.reused': ['name'],
  'utang.payment_recorded': ['amount', 'customerName', 'note'],
  'expense.recorded': ['amount', 'category', 'description', 'occurredAt'],
  'staff.created': ['targetDisplayName', 'targetRole'],
  'staff.disabled': ['targetDisplayName', 'targetRole'],
  'staff.reactivated': ['targetDisplayName', 'targetRole'],
  'staff.credential_reset': ['targetDisplayName', 'targetRole', 'credentialType'],
  'store.created': ['ownerDisplayName'],
  'store.suspended': [],
  'store.reactivated': [],
  'auth.signed_in': ['method'],
  'auth.signed_out': [],
  'payment.qrph_configured': ['contentType', 'byteLength'],
  'payment.qrph_removed': [],
  'product.image_uploaded': ['contentType', 'byteLength'],
  'product.image_deleted': [],
  'backup.created': ['byteLength'],
  'data.legacy_imported': ['products', 'sales', 'customers', 'expenses'],
};

export const activityStatusLabels: Record<ActivityLog['status'], string> = {
  confirmed: 'Synced',
  pending: 'Waiting to sync',
  needs_attention: 'Sync issue',
};

export function formatActivityRole(role: Role) {
  return role === 'superadmin' ? 'Superadmin' : titleCase(role);
}

export function buildActivityPresentation(item: ActivityLog): ActivityPresentation {
  const flattened = flattenDetails(item.details);
  const used = new Set<string>();
  const details: ActivityDetailItem[] = [];
  const changes: ActivityChangeItem[] = [];

  for (const path of actionFields[item.action] ?? []) {
    const found = flattened.find((entry) => entry.path === path);
    if (!found || shouldSkip(found.value)) continue;
    used.add(found.path);
    details.push({ label: labelFor(found.key), value: formatDetailValue(found.key, found.value) });
  }

  const before = asRecord(item.details.before);
  const after = asRecord(item.details.after);
  if (before && after) {
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      used.add(`before.${key}`);
      used.add(`after.${key}`);
      if (isTechnicalKey(key) || valuesEqual(before[key], after[key])) continue;
      changes.push({
        label: labelFor(key),
        before: formatDetailValue(key, before[key]),
        after: formatDetailValue(key, after[key]),
      });
    }
  }

  const technical: ActivityDetailItem[] = [
    { label: 'Activity type', value: item.action },
    { label: 'Activity log ID', value: item.id },
    ...(item.entityType ? [{ label: 'Record type', value: titleCase(item.entityType) }] : []),
    ...(item.entityId ? [{ label: 'Record ID', value: item.entityId }] : []),
    ...(item.deviceId ? [{ label: 'Device ID', value: item.deviceId }] : []),
    ...(item.clientCommandId ? [{ label: 'Sync command ID', value: item.clientCommandId }] : []),
    ...(item.confirmedAt ? [{ label: 'Confirmed at', value: formatDate(item.confirmedAt) }] : []),
  ];

  for (const entry of flattened) {
    if (used.has(entry.path) || shouldSkip(entry.value)) continue;
    const target = isTechnicalPath(entry.path) ? technical : details;
    target.push({ label: labelFor(entry.key), value: formatDetailValue(entry.key, entry.value) });
  }

  return {
    details: dedupeItems(details),
    changes,
    technical: dedupeItems(technical),
  };
}

function flattenDetails(value: unknown, parent = ''): FlatDetail[] {
  if (!isRecord(value)) return [];
  return Object.entries(value).flatMap(([key, child]) => {
    const path = parent ? `${parent}.${key}` : key;
    return isRecord(child) ? flattenDetails(child, path) : [{ path, key, value: child }];
  });
}

function labelFor(key: string) {
  return detailLabels[key] ?? titleCase(key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replaceAll('_', ' '))
    .replace(/\bId\b/g, 'ID')
    .replace(/\bQr\b/g, 'QR')
    .replace(/\bPin\b/g, 'PIN');
}

function formatDetailValue(key: string, value: unknown): string {
  if (value === null || value === undefined || value === '') return 'Not provided';
  if (moneyKeys.has(key) && typeof value === 'number') return formatMoney(value);
  if (dateKeys.has(key) && typeof value === 'string') return formatDate(value);
  if (key === 'byteLength' && typeof value === 'number') return formatBytes(value);
  if (key === 'paymentMethod' && typeof value === 'string') return paymentLabels[value as PaymentMethod] ?? titleCase(value);
  if (key === 'method' && typeof value === 'string') return ({ password: 'Password', pin: 'Cashier PIN', initial_setup: 'Initial store setup' } as Record<string, string>)[value] ?? titleCase(value);
  if (key === 'mode' && typeof value === 'string') return value === 'add' ? 'Add to current stock' : value === 'set' ? 'Set exact stock' : titleCase(value);
  if (key === 'credentialType' && typeof value === 'string') return value.toLowerCase() === 'pin' ? 'PIN' : titleCase(value);
  if (key === 'isActive' && typeof value === 'boolean') return value ? 'Active' : 'Inactive';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') return new Intl.NumberFormat('en-PH', { maximumFractionDigits: 6 }).format(value);
  if (Array.isArray(value)) return value.length ? value.map((entry) => formatUnknown(entry)).join(', ') : 'None';
  if (isRecord(value)) return Object.entries(value).map(([childKey, child]) => `${labelFor(childKey)}: ${formatDetailValue(childKey, child)}`).join('; ');
  if (typeof value === 'string' && (key === 'reason' || key === 'decision' || key === 'confirmationSource' || key === 'targetRole')) return titleCase(value);
  return String(value);
}

function formatUnknown(value: unknown): string {
  if (value === null || value === undefined || value === '') return 'Not provided';
  if (Array.isArray(value)) return value.map(formatUnknown).join(', ');
  if (isRecord(value)) return Object.entries(value).map(([key, child]) => `${labelFor(key)}: ${formatDetailValue(key, child)}`).join('; ');
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value);
}

function formatMoney(value: number) {
  return new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP' }).format(value / 100);
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('en-PH', {
    timeZone: 'Asia/Manila', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  }).format(date);
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function isTechnicalPath(path: string) {
  return path.split('.').some(isTechnicalKey);
}

function isTechnicalKey(key: string) {
  return technicalKeys.has(key) || key.endsWith('Id') || key.endsWith('Version') || key.toLowerCase().includes('command');
}

function titleCase(value: string) {
  return value.replaceAll('_', ' ').replaceAll('.', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function shouldSkip(value: unknown) {
  return value === undefined || value === '';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function valuesEqual(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function dedupeItems(items: ActivityDetailItem[]) {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.label}\u0000${item.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
