import type { ActivityLog } from '@gma/contracts';
import { describe, expect, it } from 'vitest';
import { buildActivityPresentation } from '../lib/activity-log-presentation';

const now = '2026-10-01T01:00:00.000Z';

function activity(action: string, details: Record<string, unknown>): ActivityLog {
  return {
    id: 'log-1',
    storeId: 'store-1',
    actor: { userId: 'owner-1', displayName: 'Store Owner', role: 'owner' },
    submittedBy: null,
    deviceId: 'device-1',
    deviceName: 'Front counter',
    category: 'store',
    action,
    entityType: 'record',
    entityId: 'record-1',
    summary: 'Test activity',
    details,
    clientCommandId: 'command-1',
    status: 'confirmed',
    occurredAt: now,
    confirmedAt: now,
  };
}

describe('activity log owner-facing presentation', () => {
  it.each([
    ['sale.completed', { transactionNumber: 'POS-100', total: 12500, paymentMethod: 'qrph', itemCount: 3, utangPurchase: false }, ['Transaction number', 'POS-100', 'Sale total', '₱125.00', 'Payment method', 'QR Ph', 'Items', '3']],
    ['inventory.adjusted', { inputQuantity: -2, reason: 'supplier_shortage', note: 'Two missing cases' }, ['Quantity entered', '-2', 'Reason', 'Supplier Shortage', 'Note', 'Two missing cases']],
    ['product.created', { after: { name: 'Rice', category: 'Staples', costPrice: 4200, sellingPrice: 4800, stockQuantity: 10, unit: 'kg', isActive: true } }, ['Name', 'Rice', 'Cost price', '₱42.00', 'Selling price', '₱48.00', 'Status', 'Active']],
    ['expense.recorded', { amount: 500, category: 'Supplies', description: 'Paper bags', occurredAt: now }, ['Amount', '₱5.00', 'Category', 'Supplies', 'Description', 'Paper bags', 'Business date']],
    ['utang.payment_recorded', { amount: 2500, note: 'Weekly payment' }, ['Amount', '₱25.00', 'Note', 'Weekly payment']],
    ['auth.signed_in', { method: 'pin' }, ['Sign-in method', 'Cashier PIN']],
    ['payment.qrph_rejected', { decision: 'reject', note: 'Reference did not match' }, ['Decision', 'Reject', 'Note', 'Reference did not match']],
    ['backup.created', { byteLength: 15360, schemaVersion: 2 }, ['File size', '15 KB']],
    ['data.legacy_imported', { products: 10, sales: 20, customers: 4, expenses: 3 }, ['Products imported', '10', 'Sales imported', '20', 'Customers imported', '4', 'Expenses imported', '3']],
  ])('formats %s for a store owner', (action, source, expected) => {
    const result = buildActivityPresentation(activity(action, source));
    const readable = result.details.flatMap((item) => [item.label, item.value]);
    for (const value of expected) expect(readable).toContain(value);
  });

  it('presents staff access changes as before and after states', () => {
    const result = buildActivityPresentation(activity('staff.disabled', {
      targetDisplayName: 'Ana Cashier',
      targetRole: 'cashier',
      before: { isActive: true },
      after: { isActive: false },
    }));

    expect(result.details).toEqual(expect.arrayContaining([
      { label: 'Staff member', value: 'Ana Cashier' },
      { label: 'Role', value: 'Cashier' },
    ]));
    expect(result.changes).toEqual([{ label: 'Status', before: 'Active', after: 'Inactive' }]);
  });

  it('keeps identifiers and support metadata out of business details', () => {
    const result = buildActivityPresentation(activity('inventory.adjusted', {
      productUnitId: 'unit-1',
      expectedVersion: 12,
      newQuantity: 9,
      note: 'Count correction',
    }));

    expect(result.details).toEqual(expect.arrayContaining([
      { label: 'New stock level', value: '9' },
      { label: 'Note', value: 'Count correction' },
    ]));
    expect(result.details.map((item) => item.value)).not.toContain('unit-1');
    expect(result.technical).toEqual(expect.arrayContaining([
      { label: 'Product Unit ID', value: 'unit-1' },
      { label: 'Expected Version', value: '12' },
      { label: 'Sync command ID', value: 'command-1' },
    ]));
  });

  it('formats unknown future fields without leaking object stringification', () => {
    const result = buildActivityPresentation(activity('future.action', {
      deliveryWindow: { startTime: '8:00 AM', confirmed: true },
      tags: ['priority', 'supplier'],
    }));
    const values = result.details.map((item) => item.value).join(' ');

    expect(values).toContain('8:00 AM');
    expect(values).toContain('Yes');
    expect(values).toContain('priority, supplier');
    expect(values).not.toContain('[object Object]');
  });
});
