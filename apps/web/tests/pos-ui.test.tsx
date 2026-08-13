import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CheckoutModal, ProductForm } from '../components/pos-app';
import { db, saveSession } from '../lib/db';

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
    await db.delete();
  });

  it('creates and selects a customer inline for Utang checkout', async () => {
    const complete = vi.fn().mockResolvedValue(undefined);
    render(<CheckoutModal total={2500} customers={[]} onClose={vi.fn()} onComplete={complete} />);
    fireEvent.click(screen.getByRole('button', { name: 'UTANG' }));
    const input = screen.getByRole('combobox', { name: 'Customer' });
    fireEvent.change(input, { target: { value: 'Aling Rosa' } });
    fireEvent.click(screen.getByRole('button', { name: /Add “Aling Rosa”/ }));

    await waitFor(async () => expect(await db.customers.count()).toBe(1));
    const completeButton = screen.getByRole('button', { name: /COMPLETE SALE/ }) as HTMLButtonElement;
    await waitFor(() => expect(completeButton.disabled).toBe(false));
    fireEvent.click(completeButton);
    await waitFor(() => expect(complete).toHaveBeenCalledWith('utang', null, expect.any(String)));
  });

  it('labels Maya as a manually confirmed payment', () => {
    render(<CheckoutModal total={2500} customers={[]} onClose={vi.fn()} onComplete={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'MAYA' }));
    expect(screen.getByText('Manual confirmation')).toBeTruthy();
    expect(screen.getByText(/Maya API is not connected/)).toBeTruthy();
  });

  it('uses the reusable scanner manual fallback to populate a product barcode', async () => {
    render(<ProductForm product={null} onClose={vi.fn()} barcodeSuggestions={[{ code: '4801234567890', label: 'Coffee', detail: 'Drinks · 10 sachet' }]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Scan product barcode' }));
    fireEvent.change(await screen.findByRole('combobox', { name: 'Barcode' }), { target: { value: '480123' } });
    fireEvent.click(screen.getByRole('option', { name: /4801234567890/ }));
    expect((screen.getByLabelText('Barcode (optional)') as HTMLInputElement).value).toBe('4801234567890');
  });
});
