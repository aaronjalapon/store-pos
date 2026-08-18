import { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { AuthSession, Customer, Product, ProductUnit } from '@gma/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InventoryView, MoreView, ProductForm, SellView, UtangView } from '../components/pos-app';
import { QuickRestockModal, RecordPaymentModal, StockAdjustmentModal } from '../components/pos-dialogs';
import { AppModal } from '../components/app-modal';
import { BackupPanel } from '../components/backup-panel';
import { StaffPanel } from '../components/staff-panel';
import { SuperadminConsole } from '../components/superadmin-console';
import { db, saveSession } from '../lib/db';
import * as backupModule from '../lib/backup';
import * as apiModule from '../lib/api';
import * as posModule from '../lib/pos';

const now = '2026-08-12T00:00:00.000Z';
const baseRecord = { storeId: 'store', createdAt: now, updatedAt: now, recordVersion: 1 };
const session: AuthSession = {
  token: 'test-token',
  store: { id: 'store', name: 'GMA Store', createdAt: now, updatedAt: now },
  device: { id: 'device', storeId: 'store', name: 'Test browser', firstSyncedAt: now, lastSeenAt: now, createdAt: now, updatedAt: now },
  user: { id: 'user', displayName: 'Test Owner', email: 'owner@example.com', staffCode: null, role: 'owner' },
};
const superadminSession: AuthSession = {
  token: 'super-token',
  store: null,
  device: null,
  user: { id: 'super', displayName: 'Super Admin', email: 'super@example.com', staffCode: null, role: 'superadmin' },
};
const cashierSession: AuthSession = {
  ...session,
  user: { ...session.user, email: null, staffCode: 'CASH001', role: 'cashier' },
};

function customer(id: string, name: string, nickname: string | null, phoneNumber: string | null): Customer {
  return { ...baseRecord, id, name, nickname, phoneNumber, notes: null, isActive: true };
}

function product(overrides: Partial<Product> = {}): Product {
  return {
    ...baseRecord, id: crypto.randomUUID(), barcode: null, sku: null, imageRevision: null,
    name: 'Test product', category: 'Other', costPrice: 500, sellingPrice: 700,
    stockQuantity: 3, unit: 'piece', soldByWeight: false, quantityStep: 1,
    lowStockThreshold: 1, isQuickItem: true, isActive: true,
    ...overrides,
  };
}

function productUnit(productId: string, overrides: Partial<ProductUnit> = {}): ProductUnit {
  return {
    ...baseRecord, id: crypto.randomUUID(), productId, name: 'piece', symbol: 'pc',
    multiplierBaseUnits: 1, quantityStep: 1, canSell: true, canRestock: true,
    allowAmountPricing: false, sellingPrice: 700, costPrice: 500, barcode: null,
    isBase: true, isActive: true, replacesUnitId: null,
    ...overrides,
  };
}

describe('Utang search and app modal improvements', () => {
  beforeEach(async () => { await db.delete(); await db.open(); });
  beforeEach(async () => {
    await saveSession(session);
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
  });
  afterEach(async () => { cleanup(); await db.delete(); vi.restoreAllMocks(); });

  it('filters customers by name, nickname, and phone without replacing the selected ledger', () => {
    const customers = [customer('alice', 'Alice Santos', 'Aling Alice', '09171111111'), customer('bob', 'Roberto Cruz', 'Bobby', '09992222222')];
    render(<UtangView customers={customers} entries={[]} />);
    const search = screen.getByPlaceholderText('Search customers…');

    fireEvent.change(search, { target: { value: 'bObBy' } });
    expect(screen.getByRole('button', { name: /Roberto Cruz/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Alice Santos/ })).toBeNull();
    expect(screen.getByText('Alice Santos')).toBeTruthy();

    fireEvent.change(search, { target: { value: '0999' } });
    fireEvent.click(screen.getByRole('button', { name: /Roberto Cruz/ }));
    expect(screen.getAllByText('Roberto Cruz')).toHaveLength(2);

    fireEvent.change(search, { target: { value: 'missing' } });
    expect(screen.getByText('No matching customers')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect((search as HTMLInputElement).value).toBe('');
  });

  it('opens Add Customer from an empty search with the search text retained', () => {
    render(<UtangView customers={[]} entries={[]} />);
    fireEvent.change(screen.getByPlaceholderText('Search customers…'), { target: { value: 'Aling Nena' } });
    fireEvent.click(screen.getAllByRole('button', { name: /Add customer/ }).at(-1)!);
    expect((screen.getByLabelText('Customer name') as HTMLInputElement).value).toBe('Aling Nena');
  });

  it('records overpayment as customer credit through the modal', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    render(<RecordPaymentModal customer={customer('alice', 'Alice Santos', null, null)} balance={1000} onClose={vi.fn()} onSave={save} />);
    fireEvent.change(screen.getByLabelText('Payment amount'), { target: { value: '20.00' } });
    expect(screen.getAllByText(/customer credit/)).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Record payment' }));
    await waitFor(() => expect(save).toHaveBeenCalledWith(2000));
  });

  it('validates and saves stock quantity in an app modal', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    render(<StockAdjustmentModal product={product({ stockQuantity: 3 })} onClose={vi.fn()} onSave={save} />);
    fireEvent.change(screen.getByLabelText('New stock quantity'), { target: { value: '8' } });
    expect(screen.getByText('+5 piece')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save quantity' }));
    await waitFor(() => expect(save).toHaveBeenCalledWith(8));
  });

  it('searches and selects category and unit options in the Product form', () => {
    render(<ProductForm product={null} onClose={vi.fn()} />);
    const category = screen.getByRole('combobox', { name: 'Category' });
    const unit = screen.getByRole('combobox', { name: 'Unit' });

    fireEvent.focus(category);
    expect(screen.getByRole('option', { name: 'Drinks' })).toBeTruthy();
    fireEvent.change(category, { target: { value: 'sna' } });
    expect(screen.getByRole('option', { name: 'Snacks' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: 'Drinks' })).toBeNull();
    fireEvent.keyDown(category, { key: 'Enter' });
    expect((category as HTMLInputElement).value).toBe('Snacks');

    fireEvent.change(unit, { target: { value: 'bot' } });
    fireEvent.click(screen.getByRole('option', { name: 'bottle' }));
    expect((unit as HTMLInputElement).value).toBe('bottle');
  });

  it('keeps custom category values available', () => {
    render(<ProductForm product={null} onClose={vi.fn()} />);
    const category = screen.getByRole('combobox', { name: 'Category' });
    fireEvent.change(category, { target: { value: 'Local specialty' } });
    fireEvent.click(screen.getByRole('option', { name: 'Use “Local specialty”' }));
    expect((category as HTMLInputElement).value).toBe('Local specialty');
  });

  it('configures weighted products with decimal stock and quantity steps', () => {
    render(<ProductForm product={null} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('checkbox', { name: /Sold by weight/ }));
    expect((screen.getByRole('combobox', { name: 'Unit' }) as HTMLInputElement).value).toBe('kg');
    expect((screen.getByLabelText('Quantity step (kg)') as HTMLInputElement).value).toBe('0.01');
    expect(screen.getByLabelText('Stock quantity (kg)').getAttribute('step')).toBe('0.01');
    expect(screen.getByLabelText('Selling price per kg')).toBeTruthy();
  });

  it('allows decimal stock adjustment for weighted products', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    render(<StockAdjustmentModal product={product({ unit: 'kg', soldByWeight: true, quantityStep: 0.01, stockQuantity: 5 })} onClose={vi.fn()} onSave={save} />);
    fireEvent.change(screen.getByLabelText('New stock quantity'), { target: { value: '4.25' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save quantity' }));
    await waitFor(() => expect(save).toHaveBeenCalledWith(4.25));
  });

  it('saves quick restock in add-stock mode after scanning a known barcode', async () => {
    const coke = product({ name: 'Coke 290ml', barcode: '4801981110017', stockQuantity: 5 });
    await db.products.add(coke);
    render(<InventoryView products={[coke]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Quick Restock' }));
    fireEvent.change(await screen.findByLabelText('Barcode'), { target: { value: coke.barcode } });
    fireEvent.click(screen.getByRole('button', { name: 'Use code' }));

    expect(screen.getByRole('dialog', { name: 'Restock Coke 290ml' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Incoming quantity (piece)'), { target: { value: '12' } });
    expect(screen.getByText('+12 piece')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save restock' }));
    await waitFor(async () => expect((await db.products.get(coke.id))?.stockQuantity).toBe(17));
  });

  it('opens restock directly from an active inventory row and disables it for inactive products', () => {
    const active = product({ name: 'Active drink' });
    const inactive = product({ name: 'Archived drink', isActive: false });
    render(<InventoryView products={[active, inactive]} />);

    expect((screen.getByRole('button', { name: 'Restock Archived drink' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Restock Active drink' }));

    expect(screen.getByRole('dialog', { name: 'Restock Active drink' })).toBeTruthy();
    expect(screen.queryByRole('combobox', { name: 'Barcode' })).toBeNull();
  });

  it('defaults to a configured bulk unit and adds its converted base stock', async () => {
    const item = product({ name: 'Bottled drink', stockQuantity: 5, stockBaseQuantity: 5, baseUnit: 'piece' });
    const base = productUnit(item.id);
    const bulk = productUnit(item.id, {
      name: 'case', symbol: 'case', multiplierBaseUnits: 24, barcode: 'CASE-24', isBase: false,
    });
    item.defaultRestockUnitId = bulk.id;
    item.displayUnitId = base.id;
    item.baseUnitId = base.id;
    await db.products.add(item);
    await db.productUnits.bulkAdd([base, bulk]);

    render(<InventoryView products={[item]} productUnits={[base, bulk]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Restock Bottled drink' }));

    expect((screen.getByRole('combobox', { name: 'Restock unit' }) as HTMLSelectElement).value).toBe(bulk.id);
    fireEvent.change(screen.getByLabelText('Incoming quantity (case)'), { target: { value: '0' } });
    expect((screen.getByRole('button', { name: 'Save restock' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Incoming quantity (case)'), { target: { value: '1.5' } });
    expect((screen.getByRole('button', { name: 'Save restock' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Incoming quantity (case)'), { target: { value: '2' } });
    expect(screen.getByText('+48 piece')).toBeTruthy();
    expect(screen.getByText('53 piece')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save restock' }));

    await waitFor(async () => expect((await db.products.get(item.id))?.stockBaseQuantity).toBe(53));
    expect(await db.products.get(item.id)).toMatchObject({ stockQuantity: 53 });
    expect(await db.inventoryMovements.where('productId').equals(item.id).first()).toMatchObject({
      reason: 'restock', productUnitId: bulk.id, inputQuantity: 2, inputUnitSnapshot: 'case',
      multiplierBaseUnitsSnapshot: 24, baseQuantityDelta: 48, stockAfterBase: 53,
    });
    expect((await db.mutationQueue.toArray())[0].request.command).toMatchObject({
      type: 'receiveStock', payload: { productId: item.id, productUnitId: bulk.id, inputQuantity: 2 },
    });
  });

  it('recognizes a bulk-unit barcode and preselects that restock unit', async () => {
    const item = product({ name: 'Bottled drink', barcode: 'BOTTLE', stockBaseQuantity: 5, baseUnit: 'piece' });
    const base = productUnit(item.id, { barcode: item.barcode });
    const bulk = productUnit(item.id, { name: 'case', multiplierBaseUnits: 24, barcode: 'CASE-24', isBase: false });
    item.defaultRestockUnitId = base.id;
    render(<InventoryView products={[item]} productUnits={[base, bulk]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Quick Restock' }));
    fireEvent.change(await screen.findByLabelText('Barcode'), { target: { value: bulk.barcode } });
    fireEvent.click(screen.getByRole('button', { name: 'Use code' }));

    expect((screen.getByRole('combobox', { name: 'Restock unit' }) as HTMLSelectElement).value).toBe(bulk.id);
    expect(screen.getByLabelText('Incoming quantity (case)')).toBeTruthy();
  });

  it('supports set-total mode and validates regular restock quantities', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    render(<QuickRestockModal product={product({ stockQuantity: 5 })} onClose={vi.fn()} onSave={save} />);
    fireEvent.change(screen.getByLabelText('Incoming quantity (piece)'), { target: { value: '1.5' } });
    expect((screen.getByRole('button', { name: 'Save restock' }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Set total' }));
    fireEvent.change(screen.getByLabelText('Final stock (piece)'), { target: { value: '12' } });
    expect(screen.getByText('+7 piece')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save restock' }));
    await waitFor(() => expect(save).toHaveBeenCalledWith('set', 12, null));
  });

  it('accepts weighted quick restock increments', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    render(<QuickRestockModal product={product({ name: 'Pork', unit: 'kg', soldByWeight: true, quantityStep: 0.01, stockQuantity: 5 })} onClose={vi.fn()} onSave={save} />);
    fireEvent.change(screen.getByLabelText('Incoming quantity (kg)'), { target: { value: '0.75' } });
    expect(screen.getByText('+0.75 kg')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save restock' }));
    await waitFor(() => expect(save).toHaveBeenCalledWith('add', 0.75, null));
  });

  it('closes on Escape and restores focus to the trigger', async () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return <><button onClick={() => setOpen(true)}>Open modal</button>{open && <AppModal title="Accessible dialog" onClose={() => setOpen(false)}><input data-autofocus aria-label="Focused field" /></AppModal>}</>;
    }
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Open modal' });
    trigger.focus();
    fireEvent.click(trigger);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Focused field')));
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it('uses a destructive restore modal and retains the recovery code after cancel', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ latestBackupAt: null, backupCount: 0 }), { status: 200 })));
    render(<BackupPanel />);
    await screen.findByText('Server backups');
    expect(screen.getByText('No backup yet')).toBeTruthy();
  });

  it('shows an inline access warning for backup status denial without an unhandled rejection', async () => {
    const accessDenied = new Error('You do not have access to this action');
    const unhandled = vi.fn();
    vi.spyOn(backupModule, 'getBackupStatus').mockRejectedValue(accessDenied);
    window.addEventListener('unhandledrejection', unhandled);

    render(<BackupPanel />);

    expect(await screen.findByText('You do not have access to this action')).toBeTruthy();
    expect(unhandled).not.toHaveBeenCalled();

    window.removeEventListener('unhandledrejection', unhandled);
  });

  it('shows an inline access warning for staff denial and disables manager actions', async () => {
    const onAccessDenied = vi.fn();
    vi.spyOn(apiModule, 'listStaff').mockRejectedValue(new Error('You do not have access to this action'));

    render(<StaffPanel onAccessDenied={onAccessDenied} />);

    expect(await screen.findByText('You do not have access to this action')).toBeTruthy();
    expect(onAccessDenied).toHaveBeenCalledWith('You do not have access to this action');
    await waitFor(() => expect(screen.getByRole('button', { name: /Add staff/i }).hasAttribute('disabled')).toBe(true));
  });

  it('lets managers add both admin and cashier accounts', async () => {
    vi.spyOn(apiModule, 'listStaff').mockResolvedValue([]);
    const createStaff = vi.spyOn(apiModule, 'createStaff').mockResolvedValue({
      id: 'staff-1', displayName: 'New staff', email: 'staff@example.com', staffCode: null,
      role: 'admin', isActive: true, createdAt: now, updatedAt: now,
    });

    render(<StaffPanel />);

    fireEvent.change(screen.getByRole('combobox', { name: 'Role' }), { target: { value: 'admin' } });
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'New admin' } });
    fireEvent.change(screen.getByLabelText('Email (admin only)'), { target: { value: 'admin@example.com' } });
    fireEvent.change(screen.getByLabelText('Password / PIN'), { target: { value: 'ChangeMe123!' } });
    fireEvent.click(screen.getByRole('button', { name: /Add staff/i }));

    await waitFor(() => expect(createStaff).toHaveBeenCalledWith({
      role: 'admin', displayName: 'New admin', email: 'admin@example.com', password: 'ChangeMe123!',
    }));

    fireEvent.change(screen.getByRole('combobox', { name: 'Role' }), { target: { value: 'cashier' } });
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'New cashier' } });
    fireEvent.change(screen.getByLabelText('Staff code (cashier only)'), { target: { value: 'CASH002' } });
    fireEvent.change(screen.getByLabelText('Password / PIN'), { target: { value: '1234' } });
    fireEvent.click(screen.getByRole('button', { name: /Add staff/i }));

    await waitFor(() => expect(createStaff).toHaveBeenCalledWith({
      role: 'cashier', displayName: 'New cashier', staffCode: 'CASH002', pin: '1234',
    }));
  });

  it('keeps cashier accounts in Account view without authorization controls', () => {
    render(<MoreView expenses={[]} session={cashierSession} onLogout={vi.fn().mockResolvedValue(undefined)} />);

    expect(screen.getByRole('heading', { name: 'Account' })).toBeTruthy();
    expect(screen.queryByText('Staff access')).toBeNull();
    expect(screen.queryByRole('button', { name: /Add staff/i })).toBeNull();
  });

  it('surfaces a shared manager warning when recording an expense is denied', async () => {
    vi.spyOn(backupModule, 'getBackupStatus').mockResolvedValue({ latestBackupAt: null, backupCount: 0 });
    vi.spyOn(apiModule, 'listStaff').mockResolvedValue([]);
    vi.spyOn(posModule, 'recordExpense').mockRejectedValue(new Error('You do not have access to this action'));

    render(<MoreView expenses={[]} session={session} onLogout={vi.fn().mockResolvedValue(undefined)} />);

    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Plastic bags' } });
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '100.00' } });
    fireEvent.click(screen.getByRole('button', { name: /Save expense/i }));

    expect((await screen.findByRole('alert')).textContent).toContain('You do not have access to this action');
    expect(screen.getByRole('button', { name: /Save expense/i }).hasAttribute('disabled')).toBe(true);
    expect(screen.queryByText('Expense saved.')).toBeNull();
    expect(screen.getByText(session.user.displayName)).toBeTruthy();
  });

  it('lets a superadmin create a store from the global console', async () => {
    const storeSummary = { id: 'store-1', name: 'Branch 1', isActive: true, ownerCount: 1, adminCount: 0, cashierCount: 0, lastActivityAt: now, lastDeviceSeenAt: now, latestBackupAt: null, backupCount: 0, createdAt: now, updatedAt: now };
    vi.spyOn(apiModule, 'listSuperadminStores')
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([storeSummary]);
    vi.spyOn(apiModule, 'getSuperadminStoreDetails').mockResolvedValue({
      store: storeSummary,
      staff: [{ id: 'owner-1', displayName: 'Owner One', email: 'owner1@example.com', staffCode: null, role: 'owner', isActive: true, createdAt: now, updatedAt: now }],
    });
    const createStore = vi.spyOn(apiModule, 'createSuperadminStore').mockResolvedValue({
      store: storeSummary,
      staff: { id: 'owner-1', displayName: 'Owner One', email: 'owner1@example.com', staffCode: null, role: 'owner', isActive: true, createdAt: now, updatedAt: now },
    });

    render(<SuperadminConsole session={superadminSession} onLogout={vi.fn().mockResolvedValue(undefined)} />);

    fireEvent.change(screen.getByLabelText('Store name'), { target: { value: 'Branch 1' } });
    fireEvent.change(screen.getByLabelText('Owner name'), { target: { value: 'Owner One' } });
    fireEvent.change(screen.getByLabelText('Owner email'), { target: { value: 'owner1@example.com' } });
    fireEvent.change(screen.getByLabelText('Owner password'), { target: { value: 'ChangeMe123!' } });
    fireEvent.click(screen.getByRole('button', { name: /Create store/i }));

    await waitFor(() => expect(createStore).toHaveBeenCalledWith({
      storeName: 'Branch 1',
      ownerDisplayName: 'Owner One',
      ownerEmail: 'owner1@example.com',
      ownerPassword: 'ChangeMe123!',
    }));
    expect(await screen.findByText('Store and owner created.')).toBeTruthy();
    expect((await screen.findAllByText('Branch 1')).length).toBeGreaterThan(0);
  });

  it('lets a superadmin inspect and suspend a store', async () => {
    const activeStore = { id: 'store-2', name: 'Branch 2', isActive: true, ownerCount: 1, adminCount: 1, cashierCount: 2, lastActivityAt: now, lastDeviceSeenAt: now, latestBackupAt: now, backupCount: 1, createdAt: now, updatedAt: now };
    const suspendedStore = { ...activeStore, isActive: false };
    const staff = [
      { id: 'owner-2', displayName: 'Owner Two', email: 'owner2@example.com', staffCode: null, role: 'owner' as const, isActive: true, createdAt: now, updatedAt: now },
      { id: 'admin-2', displayName: 'Admin Two', email: 'admin2@example.com', staffCode: null, role: 'admin' as const, isActive: true, createdAt: now, updatedAt: now },
    ];
    vi.spyOn(apiModule, 'listSuperadminStores').mockResolvedValue([activeStore]);
    vi.spyOn(apiModule, 'getSuperadminStoreDetails').mockResolvedValue({ store: activeStore, staff });
    const update = vi.spyOn(apiModule, 'updateSuperadminStoreStatus').mockResolvedValue({ store: suspendedStore, staff });

    render(<SuperadminConsole session={superadminSession} onLogout={vi.fn().mockResolvedValue(undefined)} />);

    expect((await screen.findAllByText('Branch 2')).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Inspect' }));
    expect(await screen.findByRole('heading', { name: 'Branch 2' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Suspend store' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Suspend store' }).at(-1)!);

    await waitFor(() => expect(update).toHaveBeenCalledWith('store-2', { isActive: false }));
  });
});

describe('unknown barcode product creation', () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
    await saveSession(session);
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
  });
  afterEach(async () => { cleanup(); await db.delete(); });

  it('confirms an unknown barcode, prefills Add Product, and adds the saved product to the cart', async () => {
    render(<SellView products={[]} customers={[]} allowProductCreation />);
    fireEvent.click(screen.getByRole('button', { name: 'Scan product barcode' }));
    fireEvent.change(await screen.findByLabelText('Barcode'), { target: { value: '4801234500001' } });
    fireEvent.click(screen.getByRole('button', { name: 'Use code' }));
    const dialog = screen.getByRole('dialog', { name: 'Barcode not found' });
    expect(dialog).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add product' }));

    expect((screen.getByLabelText('Barcode (optional)') as HTMLInputElement).value).toBe('4801234500001');
    fireEvent.change(screen.getByLabelText('Product name'), { target: { value: 'New drink' } });
    fireEvent.change(screen.getByLabelText('Cost price'), { target: { value: '10.00' } });
    fireEvent.change(screen.getByLabelText('Selling price'), { target: { value: '15.00' } });
    fireEvent.change(screen.getByLabelText('Stock quantity (piece)'), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save product' }));

    await waitFor(() => expect(screen.getByText('New drink was saved and added to the cart.')).toBeTruthy());
    expect(screen.getByRole('button', { name: /1 product/ })).toBeTruthy();
  });

  it('blocks duplicate creation when an inactive product owns the barcode', async () => {
    const inactive = product({ name: 'Old stock', barcode: '4800000000999', isActive: false });
    render(<SellView products={[inactive]} customers={[]} allowProductCreation />);
    fireEvent.click(screen.getByRole('button', { name: 'Scan product barcode' }));
    fireEvent.change(await screen.findByLabelText('Barcode'), { target: { value: inactive.barcode } });
    fireEvent.click(screen.getByRole('button', { name: 'Use code' }));
    expect(screen.getByRole('dialog', { name: 'Product is inactive' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add product' })).toBeNull();
  });

  it('handles hardware-scanner keyboard input through the same confirmation flow', async () => {
    render(<SellView products={[]} customers={[]} allowProductCreation />);
    for (const key of '98765432') fireEvent.keyDown(window, { key });
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(await screen.findByRole('dialog', { name: 'Barcode not found' })).toBeTruthy();
  });

  it('shows matching Sell scanner barcode suggestions and adds the selected product', async () => {
    const coke = product({ name: 'Coke 290ml', barcode: '4801981110017', stockQuantity: 5 });
    const inactive = product({ name: 'Old Coke', barcode: '4801989999999', isActive: false });
    render(<SellView products={[coke, inactive]} customers={[]} allowProductCreation />);
    fireEvent.click(screen.getByRole('button', { name: 'Scan product barcode' }));
    fireEvent.change(await screen.findByRole('combobox', { name: 'Barcode' }), { target: { value: '480198' } });

    expect(screen.getByRole('option', { name: /4801981110017/ })).toBeTruthy();
    expect(screen.queryByRole('option', { name: /4801989999999/ })).toBeNull();
    fireEvent.click(screen.getByRole('option', { name: /4801981110017/ }));
    expect(screen.getByRole('button', { name: /1 product/ })).toBeTruthy();
  });

  it('shows matching Inventory scanner barcode suggestions, including inactive products', async () => {
    const active = product({ name: 'Coke 290ml', barcode: '4801981110017', stockQuantity: 5 });
    const inactive = product({ name: 'Old Coke', barcode: '4801989999999', isActive: false });
    render(<InventoryView products={[active, inactive]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Quick Restock' }));
    fireEvent.change(await screen.findByRole('combobox', { name: 'Barcode' }), { target: { value: '4801989' } });

    expect(screen.getByRole('option', { name: /4801989999999/ })).toBeTruthy();
  });

  it('supports keyboard selection in Sell scanner barcode suggestions', async () => {
    const coke = product({ name: 'Coke 290ml', barcode: '4801981110017', stockQuantity: 5 });
    const noodles = product({ name: 'Lucky Me noodles', barcode: '4807770270054', stockQuantity: 5 });
    render(<SellView products={[coke, noodles]} customers={[]} allowProductCreation />);
    fireEvent.click(screen.getByRole('button', { name: 'Scan product barcode' }));
    const barcode = await screen.findByRole('combobox', { name: 'Barcode' });
    fireEvent.change(barcode, { target: { value: '480' } });
    fireEvent.keyDown(barcode, { key: 'ArrowDown' });
    fireEvent.keyDown(barcode, { key: 'Enter' });

    expect(within(screen.getByLabelText('Current sale')).getByText('Lucky Me noodles')).toBeTruthy();
  });

  it('opens Add Product with a scanned unknown Inventory restock barcode', async () => {
    render(<InventoryView products={[]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Quick Restock' }));
    fireEvent.change(await screen.findByLabelText('Barcode'), { target: { value: '4801234500002' } });
    fireEvent.click(screen.getByRole('button', { name: 'Use code' }));
    const dialog = screen.getByRole('dialog', { name: 'Barcode not found' });
    expect(dialog).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add product' }));

    expect((screen.getByLabelText('Barcode (optional)') as HTMLInputElement).value).toBe('4801234500002');
  });

  it('warns and opens edit for inactive Inventory restock barcodes', async () => {
    const inactive = product({ name: 'Archived drink', barcode: '4800000000888', isActive: false });
    render(<InventoryView products={[inactive]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Quick Restock' }));
    fireEvent.change(await screen.findByLabelText('Barcode'), { target: { value: inactive.barcode } });
    fireEvent.click(screen.getByRole('button', { name: 'Use code' }));
    const dialog = screen.getByRole('dialog', { name: 'Product is inactive' });
    expect(dialog).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: 'Add product' })).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Edit product' }));
    expect((screen.getByLabelText('Product name') as HTMLInputElement).value).toBe('Archived drink');
  });

  it('calculates a weighted cart line from a decimal quantity', () => {
    const pork = product({ name: 'Pork', unit: 'kg', soldByWeight: true, quantityStep: 0.01, sellingPrice: 32000, stockQuantity: 5 });
    render(<SellView products={[pork]} customers={[]} allowProductCreation />);
    fireEvent.click(screen.getByRole('button', { name: /Pork/ }));
    const quantity = screen.getByRole('spinbutton', { name: 'Pork quantity in kg' });
    fireEvent.change(quantity, { target: { value: '0.75' } });
    expect(screen.getAllByText('₱240.00').length).toBeGreaterThan(0);
  });

  it('switches a weighted cart line to an exact peso amount and shows derived weight', () => {
    const pork = product({ name: 'Pork', unit: 'kg', soldByWeight: true, quantityStep: 0.01, sellingPrice: 32000, stockQuantity: 5 });
    render(<SellView products={[pork]} customers={[]} allowProductCreation />);
    fireEvent.click(screen.getByRole('button', { name: /Pork/ }));
    expect(screen.getByRole('button', { name: 'By weight' }).getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: 'By amount' }));
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Pork sale amount' }), { target: { value: '100.00' } });
    expect(screen.getByText('0.3125 kg calculated')).toBeTruthy();
    expect(screen.getAllByText('₱100.00').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: 'By weight' }));
    expect((screen.getByRole('spinbutton', { name: 'Pork quantity in kg' }) as HTMLInputElement).value).toBe('0.31');
  });

  it('blocks checkout when an amount exceeds weighted stock', () => {
    const pork = product({ name: 'Pork', unit: 'kg', soldByWeight: true, quantityStep: 0.01, sellingPrice: 32000, stockQuantity: 0.25 });
    render(<SellView products={[pork]} customers={[]} allowProductCreation />);
    fireEvent.click(screen.getByRole('button', { name: /Pork/ }));
    fireEvent.click(screen.getByRole('button', { name: 'By amount' }));
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Pork sale amount' }), { target: { value: '100.00' } });
    expect(screen.getByRole('alert').textContent).toContain('up to ₱80.00');
    expect((screen.getByRole('button', { name: /CHECKOUT/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('does not offer amount mode to regular or zero-priced products', () => {
    const egg = product({ name: 'Egg', unit: 'piece', soldByWeight: false, quantityStep: 1, sellingPrice: 900 });
    const freePork = product({ name: 'Free pork', unit: 'kg', soldByWeight: true, quantityStep: 0.01, sellingPrice: 0 });
    const { rerender } = render(<SellView products={[egg]} customers={[]} allowProductCreation />);
    fireEvent.click(screen.getByRole('button', { name: /Egg/ }));
    expect(screen.queryByRole('button', { name: 'By amount' })).toBeNull();

    rerender(<SellView key="free" products={[freePork]} customers={[]} allowProductCreation />);
  fireEvent.click(screen.getByRole('button', { name: /Free pork/ }));
    expect((screen.getByRole('button', { name: 'By amount' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
