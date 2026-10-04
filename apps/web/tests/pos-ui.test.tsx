import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { StoreAuthSession } from '@gma/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CheckoutModal, PosApp, ProductForm } from '../components/pos-app';
import * as apiModule from '../lib/api';
import { db, getSession, saveSession } from '../lib/db';

const now = new Date().toISOString();

describe('POS modal interactions', () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
    await saveSession({
      token: 'test-token',
      store: { id: 'store', name: 'GMA Store', createdAt: now, updatedAt: now },
      device: { id: 'device', storeId: 'store', name: 'Test browser', firstSyncedAt: now, lastSeenAt: now, createdAt: now, updatedAt: now },
      user: { id: 'user', displayName: 'Owner', email: 'owner@example.com', staffCode: null, role: 'owner' },
    });
  });

  afterEach(async () => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    await db.delete();
  });

  it('reloads server changes without syncing again while legacy and explicit local changes sync', async () => {
    const sync = vi.spyOn(apiModule, 'requestSync').mockResolvedValue(undefined);
    render(<PosApp session={(await getSession()) as StoreAuthSession} onLogout={vi.fn()} />);
    await screen.findByRole('heading', { name: 'What are we selling?' });
    expect(sync).toHaveBeenCalledTimes(1);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    act(() => { window.dispatchEvent(new CustomEvent('pos-data-changed', { detail: { source: 'server' } })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    expect(sync).toHaveBeenCalledTimes(1);
    act(() => { window.dispatchEvent(new CustomEvent('pos-data-changed', { detail: { source: 'local' } })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    expect(sync).toHaveBeenCalledTimes(2);
    act(() => { window.dispatchEvent(new Event('pos-data-changed')); });
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    expect(sync).toHaveBeenCalledTimes(3);
  });

  it('creates and selects a customer inline for Utang checkout', async () => {
    const complete = vi.fn().mockResolvedValue(undefined);
    render(<CheckoutModal total={2500} customers={[]} onClose={vi.fn()} onComplete={complete} />);
    fireEvent.click(screen.getByRole('radio', { name: 'UTANG' }));
    const input = screen.getByRole('combobox', { name: 'Customer' });
    fireEvent.change(input, { target: { value: 'Aling Rosa' } });
    fireEvent.click(screen.getByRole('button', { name: /Add “Aling Rosa”/ }));

    await waitFor(async () => expect(await db.customers.count()).toBe(1));
    const completeButton = screen.getByRole('button', { name: /COMPLETE SALE/ }) as HTMLButtonElement;
    await waitFor(() => expect(completeButton.disabled).toBe(false));
    fireEvent.click(completeButton);
    await waitFor(() => expect(complete).toHaveBeenCalledWith('utang', null, expect.any(String), null));
  });

  it('uses one QR Ph online-payment option and requires a reference', async () => {
    const revision = '00000000-0000-4000-8000-000000000099';
    const blob = new Blob(['qr-image'], { type: 'image/png' });
    await db.paymentSettings.put({ storeId: 'store', imageRevision: revision, contentType: 'image/png', byteLength: blob.size, updatedAt: now });
    await db.qrPhImages.put({ key: 'qrph', storeId: 'store', revision, blob, contentType: 'image/png', byteLength: blob.size, updatedAt: now });
    render(<CheckoutModal total={2500} customers={[]} onClose={vi.fn()} onComplete={vi.fn()} />);
    const onlinePayment = await screen.findByRole('radio', { name: 'ONLINE PAYMENT' });
    await waitFor(() => expect((onlinePayment as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(onlinePayment);
    expect(screen.getByAltText('Store QR Ph payment code')).toBeTruthy();
    expect(screen.getByText('Received on merchant device')).toBeTruthy();
    expect((screen.getByRole('button', { name: /COMPLETE SALE/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('uses the reusable scanner manual fallback to populate a product barcode', async () => {
    render(<ProductForm product={null} onClose={vi.fn()} barcodeSuggestions={[{ code: '4801234567890', label: 'Coffee', detail: 'Drinks · 10 sachet' }]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Scan product barcode' }));
    fireEvent.change(await screen.findByRole('combobox', { name: 'Barcode' }), { target: { value: '480123' } });
    fireEvent.click(screen.getByRole('option', { name: /4801234567890/ }));
    expect((screen.getByLabelText('Barcode (optional)') as HTMLInputElement).value).toBe('4801234567890');
  });
});
