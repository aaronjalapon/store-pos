import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { StoreAuthSession } from '@gma/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActivityLogPanel } from '../components/activity-log-panel';
import { MoreView } from '../components/pos-app';
import * as apiModule from '../lib/api';
import { cacheActivityLogs, db, queueCommand, saveSession } from '../lib/db';

const now = '2026-10-01T01:00:00.000Z';
const session: StoreAuthSession = {
  token: 'token',
  store: { id: 'store', name: 'GMA Store', createdAt: now, updatedAt: now },
  device: { id: 'device', storeId: 'store', name: 'Front counter', firstSyncedAt: now, lastSeenAt: now, createdAt: now, updatedAt: now },
  user: { id: 'owner', displayName: 'Test Owner', email: 'owner@example.com', staffCode: null, role: 'owner' },
};

describe('Activity log UI and cache', () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
    await saveSession(session);
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
  });
  afterEach(async () => { cleanup(); await db.delete(); vi.restoreAllMocks(); });

  it('opens from More for a manager and renders confirmed actor and role', async () => {
    vi.spyOn(apiModule, 'listActivityLogs').mockResolvedValue({
      activity: [{
        id: '10', storeId: 'store', actor: { userId: 'cashier', displayName: 'Ana Cashier', role: 'cashier' }, submittedBy: null,
        deviceId: 'device', deviceName: 'Front counter', category: 'sales', action: 'sale.completed', entityType: 'sale', entityId: 'sale',
        summary: 'Completed sale POS-100', details: { total: 12500 }, clientCommandId: null, status: 'confirmed', occurredAt: now, confirmedAt: now,
      }],
      nextCursor: null,
    });
    render(<MoreView expenses={[]} session={session} onLogout={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open activity log' }));

    expect(await screen.findByText('Completed sale POS-100')).toBeTruthy();
    expect(screen.getAllByText('Ana Cashier')).toHaveLength(2);
    expect(screen.getByText('Cashier', { selector: '.role-badge' })).toBeTruthy();
  });

  it('shows queued offline work as pending and reconciles by command id', async () => {
    await queueCommand({
      clientCommandId: '00000000-0000-4000-8000-000000000001', baseCursor: 0, occurredAt: now, actorProof: 'token',
      command: { type: 'recordExpense', payload: { category: 'Supplies', description: 'Paper bags', amount: 500, occurredAt: now } },
    });
    vi.spyOn(apiModule, 'listActivityLogs').mockResolvedValue({ activity: [], nextCursor: null });
    const view = render(<ActivityLogPanel session={session} onClose={vi.fn()} />);

    expect(await screen.findByText('Recorded expense for Paper bags')).toBeTruthy();
    expect(screen.getByText('Waiting to sync')).toBeTruthy();

    vi.mocked(apiModule.listActivityLogs).mockResolvedValue({
      activity: [{
        id: '20', storeId: 'store', actor: { userId: 'owner', displayName: 'Test Owner', role: 'owner' }, submittedBy: null,
        deviceId: 'device', deviceName: 'Front counter', category: 'expenses', action: 'expense.recorded', entityType: 'expense', entityId: 'expense',
        summary: 'Recorded ₱5.00 expense for Paper bags', details: { amount: 500 }, clientCommandId: '00000000-0000-4000-8000-000000000001', status: 'confirmed', occurredAt: now, confirmedAt: now,
      }], nextCursor: null,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(screen.getByText('Recorded ₱5.00 expense for Paper bags')).toBeTruthy());
    expect(view.container.querySelectorAll('.activity-row')).toHaveLength(1);
  });

  it('bounds the confirmed offline cache to 500 entries', async () => {
    await cacheActivityLogs(Array.from({ length: 505 }, (_, index) => ({
      id: String(index), storeId: 'store', actor: { userId: 'owner', displayName: 'Owner', role: 'owner' as const }, submittedBy: null,
      deviceId: 'device', deviceName: 'Front counter', category: 'sales' as const, action: 'sale.completed', entityType: 'sale', entityId: String(index),
      summary: `Sale ${index}`, details: {}, clientCommandId: null, status: 'confirmed' as const,
      occurredAt: new Date(Date.parse(now) + index * 1000).toISOString(), confirmedAt: now,
    })));
    expect(await db.activityLogCache.count()).toBe(500);
  });

  it('shows readable details, sync state, and collapsed technical information', async () => {
    vi.spyOn(apiModule, 'listActivityLogs').mockResolvedValue({
      activity: [{
        id: '30', storeId: 'store', actor: { userId: 'cashier', displayName: 'Ana Cashier', role: 'cashier' },
        submittedBy: { userId: 'owner', displayName: 'Test Owner', role: 'owner' },
        deviceId: 'device-technical-id', deviceName: 'Front counter', category: 'sales', action: 'sale.completed', entityType: 'sale', entityId: 'sale-technical-id',
        summary: 'Completed sale POS-200', details: { transactionNumber: 'POS-200', total: 12500, paymentMethod: 'cash', itemCount: 2 },
        clientCommandId: 'command-technical-id', status: 'confirmed', occurredAt: now, confirmedAt: now,
      }],
      nextCursor: null,
    });
    const view = render(<ActivityLogPanel session={session} onClose={vi.fn()} />);

    expect(await screen.findByText('Completed sale POS-200')).toBeTruthy();
    expect(screen.getByText('Synced')).toBeTruthy();
    expect(view.container.querySelector('.activity-category')?.textContent).toBe('Sales');
    expect(screen.getByText(/Submitted for sync by Test Owner \(Owner\) on behalf of Ana Cashier/)).toBeTruthy();

    fireEvent.click(screen.getByText('See activity details'));
    expect(screen.getByText('Sale total')).toBeTruthy();
    expect(screen.getByText('₱125.00')).toBeTruthy();
    expect(screen.getByText('Payment method')).toBeTruthy();
    expect(screen.getByText('Cash')).toBeTruthy();
    const technical = screen.getByText('Technical information').closest('details');
    expect(technical?.hasAttribute('open')).toBe(false);
    expect(technical?.textContent).toContain('command-technical-id');
    expect(view.container.querySelector('.activity-detail-grid:not(.technical)')?.textContent).not.toContain('sale-technical-id');
  });

  it('explains sync issues in owner-friendly language', async () => {
    await queueCommand({
      clientCommandId: '00000000-0000-4000-8000-000000000002', baseCursor: 0, occurredAt: now, actorProof: 'token',
      command: { type: 'recordExpense', payload: { category: 'Supplies', description: 'Labels', amount: 300, occurredAt: now } },
    });
    await db.mutationQueue.update('00000000-0000-4000-8000-000000000002', { status: 'needs_attention', errorMessage: 'This expense needs to be reviewed before syncing.' });
    vi.spyOn(apiModule, 'listActivityLogs').mockResolvedValue({ activity: [], nextCursor: null });
    render(<ActivityLogPanel session={session} onClose={vi.fn()} />);

    expect(await screen.findByText('Sync issue')).toBeTruthy();
    expect(screen.getByText('Why it needs attention')).toBeTruthy();
    expect(screen.getByText('This expense needs to be reviewed before syncing.')).toBeTruthy();
  });
});
