import { describe, expect, it } from 'vitest';
import { calculateChange, calculateSaleTotals, calculateUtangBalance } from '../src';

describe('POS calculations', () => {
  it('uses integer centavos for cart totals and change', () => {
    const totals = calculateSaleTotals([
      { productId: 'coke', quantity: 2, unitPrice: 2000, costPrice: 1500 },
      { productId: 'egg', quantity: 3, unitPrice: 900, costPrice: 700 },
    ]);

    expect(totals).toEqual({ subtotal: 6700, discount: 0, total: 6700 });
    expect(calculateChange(totals.total, 10000)).toBe(3300);
    expect(calculateChange(totals.total, 6000)).toBeNull();
  });

  it('derives utang balance from the ledger', () => {
    const base = {
      id: '1', storeId: 's', deviceId: 'd', saleId: null, note: null,
      createdAt: '', updatedAt: '', syncStatus: 'pending' as const,
    };
    expect(calculateUtangBalance([
      { ...base, customerId: 'c', kind: 'purchase', amount: 8500 },
      { ...base, id: '2', customerId: 'c', kind: 'payment', amount: 3000 },
    ])).toBe(5500);
  });

  it('rounds weighted line totals to integer centavos', () => {
    expect(calculateSaleTotals([
      { productId: 'pork', quantity: 0.75, unitPrice: 32000, costPrice: 25000 },
    ])).toEqual({ subtotal: 24000, discount: 0, total: 24000 });
  });

  it('uses an exact subtotal override for sales entered by peso amount', () => {
    expect(calculateSaleTotals([
      { productId: 'pork', quantity: 0.3125, unitPrice: 32000, costPrice: 25000, subtotalOverride: 10000 },
    ])).toEqual({ subtotal: 10000, discount: 0, total: 10000 });
  });
});
