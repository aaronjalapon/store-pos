import type { Expense, Sale, SaleItem, UtangEntry } from '@gma/contracts';

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
