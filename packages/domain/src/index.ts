import type { Expense, ProductUnit, Sale, SaleItem, UtangEntry } from '@gma/contracts';

export interface CartLine {
  productId: string;
  quantity: number;
  unitPrice: number;
  costPrice: number;
  subtotalOverride?: number;
}

export function calculateSaleTotals(lines: CartLine[], discount = 0) {
  const subtotal = lines.reduce((sum, line) => sum + (line.subtotalOverride ?? Math.round(line.quantity * line.unitPrice)), 0);
  const normalizedDiscount = Math.max(0, Math.min(discount, subtotal));
  return { subtotal, discount: normalizedDiscount, total: subtotal - normalizedDiscount };
}

export function calculateChange(total: number, cashReceived: number) {
  if (cashReceived < total) return null;
  return cashReceived - total;
}

export function calculateUtangBalance(entries: UtangEntry[]) {
  return entries.reduce((balance, entry) => {
    if (entry.kind === 'payment') return balance - entry.amount;
    return balance + entry.amount;
  }, 0);
}

export function calculateGrossProfit(sales: Sale[], items: SaleItem[]) {
  const completedSaleIds = new Set(sales.map((sale) => sale.id));
  return items.reduce((profit, item) => {
    if (!completedSaleIds.has(item.saleId)) return profit;
    return profit + item.subtotal - Math.round(item.costPriceSnapshot * item.quantity);
  }, 0);
}

export function calculateDailySummary(sales: Sale[], items: SaleItem[], expenses: Expense[]) {
  const paymentBreakdown = sales.reduce<Record<string, number>>((totals, sale) => {
    totals[sale.paymentMethod] = (totals[sale.paymentMethod] ?? 0) + sale.total;
    return totals;
  }, {});

  return {
    sales: sales.reduce((sum, sale) => sum + sale.total, 0),
    expenses: expenses.reduce((sum, expense) => sum + expense.amount, 0),
    grossProfit: calculateGrossProfit(sales, items),
    transactions: sales.length,
    paymentBreakdown,
  };
}

export function formatPeso(centavos: number) {
  return new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP' }).format(centavos / 100);
}

export function baseIncrementForUnit(unit: Pick<ProductUnit, 'multiplierBaseUnits' | 'quantityStep'>) {
  const increment = unit.multiplierBaseUnits * unit.quantityStep;
  if (!Number.isSafeInteger(Math.round(increment)) || Math.abs(increment - Math.round(increment)) > 0.000001) {
    throw new Error('Unit quantity step does not resolve to a whole base-unit increment');
  }
  return Math.round(increment);
}

export function convertToBaseUnits(unit: Pick<ProductUnit, 'multiplierBaseUnits' | 'quantityStep'>, inputQuantity: number) {
  if (!Number.isFinite(inputQuantity) || inputQuantity <= 0) throw new Error('Quantity must be above zero');
  const base = inputQuantity * unit.multiplierBaseUnits;
  const increment = baseIncrementForUnit(unit);
  if (Math.abs(base / increment - Math.round(base / increment)) > 0.000001) {
    throw new Error(`Quantity must use increments of ${unit.quantityStep}`);
  }
  return Math.round(base);
}

/** Converts an exact peso entry to inventory using nearest allowed base increment, half up. */
export function pesoToBaseUnits(
  unit: Pick<ProductUnit, 'multiplierBaseUnits' | 'quantityStep' | 'sellingPrice'>,
  amountCentavos: number,
) {
  if (!unit.sellingPrice || unit.sellingPrice <= 0 || !Number.isInteger(amountCentavos) || amountCentavos <= 0) {
    throw new Error('A positive unit price and peso amount are required');
  }
  const theoreticalInput = amountCentavos / unit.sellingPrice;
  const increment = baseIncrementForUnit(unit);
  const theoreticalBase = theoreticalInput * unit.multiplierBaseUnits;
  const rounded = Math.floor(theoreticalBase / increment + 0.5) * increment;
  if (rounded <= 0) throw new Error('Peso amount is below the minimum sale increment');
  return rounded;
}
