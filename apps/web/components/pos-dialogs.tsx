'use client';

import { useState } from 'react';
import type { Customer, Product } from '@gma/contracts';
import { formatPeso } from '@gma/domain';
import { centavosToPesoInput, pesoInputToCentavos } from '../lib/money';
import type { RestockMode } from '../lib/pos';
import { AppModal } from './app-modal';

function formatQuantity(value: number) {
  return new Intl.NumberFormat('en-PH', { maximumFractionDigits: 6 }).format(value);
}

export function StockAdjustmentModal({ product, onClose, onSave }: { product: Product; onClose: () => void; onSave: (quantity: number) => Promise<void> }) {
  const [quantity, setQuantity] = useState(String(product.stockQuantity));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const parsed = Number(quantity);
  const step = product.soldByWeight ? product.quantityStep : 1;
  const stepUnits = parsed / step;
  const valid = Number.isFinite(parsed) && parsed >= 0 && (product.soldByWeight
    ? Math.abs(stepUnits - Math.round(stepUnits)) < 0.000001
    : Number.isInteger(parsed));
  const delta = valid ? parsed - product.stockQuantity : 0;
  const help = product.soldByWeight ? `Use increments of ${step} ${product.unit}.` : 'Use a whole number.';
  return <AppModal title={`Adjust ${product.name}`} description={`Currently ${product.stockQuantity} ${product.unit} in stock. ${help}`} onClose={busy ? () => undefined : onClose}><form className="modal-form" onSubmit={async (event) => { event.preventDefault(); if (!valid) { setError(product.soldByWeight ? `Enter zero or more using ${step} ${product.unit} increments` : 'Enter a whole stock quantity of zero or more'); return; } setBusy(true); setError(''); try { await onSave(parsed); onClose(); } catch (caught) { setError(caught instanceof Error ? caught.message : 'Could not adjust stock'); setBusy(false); } }}><label>New stock quantity<input data-autofocus value={quantity} onChange={(event) => setQuantity(event.target.value)} type="number" min="0" step={step} inputMode={product.soldByWeight ? 'decimal' : 'numeric'} required /></label><div className="stock-preview"><span>Change</span><strong className={delta < 0 ? 'negative' : ''}>{delta > 0 ? '+' : ''}{delta} {product.unit}</strong></div>{error && <p className="form-message error">{error}</p>}<div className="modal-actions"><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>Cancel</button><button className="primary-button" disabled={busy || !valid}>{busy ? 'Saving…' : 'Save quantity'}</button></div></form></AppModal>;
}

export function QuickRestockModal({ product, onClose, onSave }: { product: Product; onClose: () => void; onSave: (mode: RestockMode, quantity: number) => Promise<void> }) {
  const [mode, setMode] = useState<RestockMode>('add');
  const [quantity, setQuantity] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const parsed = Number(quantity);
  const step = product.soldByWeight ? product.quantityStep : 1;
  const stepUnits = parsed / step;
  const hasQuantity = quantity.trim() !== '';
  const stepAligned = hasQuantity && Number.isFinite(parsed) && Math.abs(stepUnits - Math.round(stepUnits)) < 0.000001;
  const valid = hasQuantity && Number.isFinite(parsed) && stepAligned && (mode === 'add' ? parsed > 0 : parsed >= 0);
  const resulting = valid ? (mode === 'add' ? product.stockQuantity + parsed : parsed) : product.stockQuantity;
  const delta = valid ? resulting - product.stockQuantity : 0;
  const help = product.soldByWeight ? `Use ${step} ${product.unit} increments.` : 'Use whole-number quantities.';
  return <AppModal title={`Restock ${product.name}`} description={`Current stock: ${formatQuantity(product.stockQuantity)} ${product.unit}. ${help}`} onClose={busy ? () => undefined : onClose}><form className="modal-form" onSubmit={async (event) => { event.preventDefault(); if (!valid) { setError(mode === 'add' ? (product.soldByWeight ? `Enter more than zero using ${step} ${product.unit} increments` : 'Enter a whole quantity above zero') : (product.soldByWeight ? `Enter zero or more using ${step} ${product.unit} increments` : 'Enter a whole stock total of zero or more')); return; } setBusy(true); setError(''); try { await onSave(mode, parsed); onClose(); } catch (caught) { setError(caught instanceof Error ? caught.message : 'Could not restock product'); setBusy(false); } }}><div className="restock-product-summary"><span>BARCODE</span><strong>{product.barcode ?? 'No barcode'}</strong>{product.stockQuantity <= product.lowStockThreshold && <small>Low stock threshold: {formatQuantity(product.lowStockThreshold)} {product.unit}</small>}</div><div className="stock-mode-toggle" role="group" aria-label="Restock mode"><button type="button" className={mode === 'add' ? 'active' : ''} aria-pressed={mode === 'add'} onClick={() => { setMode('add'); setError(''); }}>Add stock</button><button type="button" className={mode === 'set' ? 'active' : ''} aria-pressed={mode === 'set'} onClick={() => { setMode('set'); setError(''); }}>Set total</button></div><label>{mode === 'add' ? `Incoming quantity (${product.unit})` : `Final stock (${product.unit})`}<input data-autofocus value={quantity} onChange={(event) => setQuantity(event.target.value)} type="number" min={mode === 'add' ? step : 0} step={step} inputMode={product.soldByWeight ? 'decimal' : 'numeric'} required /></label><div className="stock-preview"><span>Resulting stock</span><strong className={delta < 0 ? 'negative' : ''}>{formatQuantity(resulting)} {product.unit}</strong></div><div className="stock-preview compact-preview"><span>Change</span><strong className={delta < 0 ? 'negative' : ''}>{delta > 0 ? '+' : ''}{formatQuantity(delta)} {product.unit}</strong></div>{error && <p className="form-message error">{error}</p>}<div className="modal-actions"><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>Cancel</button><button className="primary-button" disabled={busy || !valid}>{busy ? 'Saving…' : 'Save restock'}</button></div></form></AppModal>;
}

export function AddCustomerModal({ initialName = '', onClose, onSave }: { initialName?: string; onClose: () => void; onSave: (name: string) => Promise<Customer> }) {
  const [name, setName] = useState(initialName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return <AppModal title="Add customer" description="Add a customer to the Utang ledger." onClose={busy ? () => undefined : onClose}><form className="modal-form" onSubmit={async (event) => { event.preventDefault(); if (!name.trim()) { setError('Enter a customer name'); return; } setBusy(true); setError(''); try { await onSave(name.trim()); onClose(); } catch (caught) { setError(caught instanceof Error ? caught.message : 'Could not add customer'); setBusy(false); } }}><label>Customer name<input data-autofocus value={name} onChange={(event) => setName(event.target.value)} autoComplete="off" required /></label>{error && <p className="form-message error">{error}</p>}<div className="modal-actions"><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>Cancel</button><button className="primary-button" disabled={busy || !name.trim()}>{busy ? 'Adding…' : 'Add customer'}</button></div></form></AppModal>;
}

export function RecordPaymentModal({ customer, balance, onClose, onSave }: { customer: Customer; balance: number; onClose: () => void; onSave: (amount: number) => Promise<void> }) {
  const [amount, setAmount] = useState(centavosToPesoInput(Math.max(balance, 0)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const centavos = pesoInputToCentavos(amount);
  return <AppModal title="Record payment" description={`Payment from ${customer.name}. Overpayments are recorded as customer credit.`} onClose={busy ? () => undefined : onClose}><form className="modal-form" onSubmit={async (event) => { event.preventDefault(); if (centavos <= 0) { setError('Enter a payment amount above zero'); return; } setBusy(true); setError(''); try { await onSave(centavos); onClose(); } catch (caught) { setError(caught instanceof Error ? caught.message : 'Could not record payment'); setBusy(false); } }}><div className="balance-summary"><span>Current balance</span><strong>{formatPeso(balance)}</strong></div><label>Payment amount<div className="money-input compact-money"><span>₱</span><input aria-label="Payment amount" data-autofocus value={amount} onChange={(event) => setAmount(event.target.value)} type="number" min="0.01" step="0.01" inputMode="decimal" required /></div></label>{centavos > balance && balance >= 0 && <p className="form-message">This creates a {formatPeso(centavos - balance)} customer credit.</p>}{error && <p className="form-message error">{error}</p>}<div className="modal-actions"><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>Cancel</button><button className="primary-button" disabled={busy || centavos <= 0}>{busy ? 'Recording…' : 'Record payment'}</button></div></form></AppModal>;
}
