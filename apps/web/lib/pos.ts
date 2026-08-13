'use client';

import type {
  Customer,
  Expense,
  PaymentMethod,
  Product,
  StoreCommand,
} from '@gma/contracts';
import { db, getStoreContext } from './db';
import { enqueueAndMaybeFlush } from './api';

export interface ProductImageInput {
  revision: string;
  blob: Blob;
  contentType: 'image/webp' | 'image/jpeg';
}

export interface CartEntry {
  product: Product;
  quantity: number;
  pricingMode?: 'quantity' | 'amount';
  enteredAmount?: number | null;
}

export interface CompleteSaleInput {
  cart: CartEntry[];
  paymentMethod: PaymentMethod;
  cashReceived: number | null;
  customerId: string | null;
}

export type RestockMode = 'add' | 'set';

function normalizeQuantity(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function isStepAligned(quantity: number, step: number) {
  const units = quantity / step;
  return Math.abs(units - Math.round(units)) < 0.000001;
}

function validateStockQuantity(product: Pick<Product, 'soldByWeight' | 'quantityStep' | 'unit'>, quantity: number) {
  const quantityStep = product.soldByWeight ? product.quantityStep : 1;
  if (!Number.isFinite(quantity) || quantity < 0 || !isStepAligned(quantity, quantityStep)) {
    throw new Error(product.soldByWeight
      ? `Stock must use increments of ${quantityStep} ${product.unit}`
      : 'Regular products require a whole-number stock quantity');
  }
}

async function applyLocalCommand<T>(command: StoreCommand, optimistic: () => Promise<T>) {
  const result = await optimistic();
  window.dispatchEvent(new Event('pos-data-changed'));
  const response = await enqueueAndMaybeFlush(command);
  if (response?.status === 'conflict') throw new Error(response.message);
  return result;
}

export async function completeSale(input: CompleteSaleInput) {
  if (!input.cart.length) throw new Error('Cart is empty');
  if (input.paymentMethod === 'utang' && !input.customerId) throw new Error('Select an utang customer');

  const context = await getStoreContext();
  const now = new Date().toISOString();
  const saleId = crypto.randomUUID();
  const transactionNumber = `POS-${now.slice(0, 10).replaceAll('-', '')}-${saleId.slice(0, 6).toUpperCase()}`;
  const command: StoreCommand = {
    type: 'completeSale',
    payload: {
      paymentMethod: input.paymentMethod,
      cashReceived: input.cashReceived,
      customerId: input.customerId,
      cart: input.cart.map((line) => ({
        productId: line.product.id,
        quantity: line.quantity,
        pricingMode: line.pricingMode ?? 'quantity',
        enteredAmount: line.enteredAmount ?? null,
        expectedVersion: line.product.recordVersion,
      })),
    },
  };

  return applyLocalCommand(command, async () => {
    const currentProducts = await db.products.bulkGet(input.cart.map(({ product }) => product.id));
    const preparedLines = input.cart.map((entry, index) => {
      const current = currentProducts[index];
      if (!current?.isActive) throw new Error(`${entry.product.name} is no longer available`);
      return prepareCartLine(entry, current);
    });
    const subtotal = preparedLines.reduce((sum, line) => sum + line.subtotal, 0);
    const total = subtotal;
    const change = input.paymentMethod === 'cash' ? calculateChange(total, input.cashReceived ?? 0) : null;
    if (input.paymentMethod === 'cash' && change === null) throw new Error('Cash received is less than the total');

    await db.transaction('rw', [db.products, db.sales, db.saleItems, db.inventoryMovements, db.utangEntries], async () => {
      await db.sales.add({
        id: saleId,
        storeId: context.storeId,
        transactionNumber,
        customerId: input.customerId,
        cashierUserId: context.userId,
        deviceId: context.deviceId,
        subtotal,
        discount: 0,
        total,
        paymentMethod: input.paymentMethod,
        cashReceived: input.cashReceived,
        changeAmount: change,
        recordVersion: 1,
        createdAt: now,
        updatedAt: now,
      });

      for (let index = 0; index < input.cart.length; index += 1) {
        const { quantity, subtotal: lineSubtotal } = preparedLines[index];
        const product = currentProducts[index]!;
        const stockAfter = normalizeQuantity(product.stockQuantity - quantity);
        await db.products.update(product.id, {
          stockQuantity: stockAfter,
          updatedAt: now,
          recordVersion: product.recordVersion + 1,
        });
        await db.saleItems.add({
          id: crypto.randomUUID(),
          storeId: context.storeId,
          saleId,
          productId: product.id,
          productNameSnapshot: product.name,
          quantity,
          unitPrice: product.sellingPrice,
          costPriceSnapshot: product.costPrice,
          subtotal: lineSubtotal,
          recordVersion: 1,
          createdAt: now,
          updatedAt: now,
        });
        await db.inventoryMovements.add({
          id: crypto.randomUUID(),
          storeId: context.storeId,
          productId: product.id,
          saleId,
          reason: 'sale',
          quantityDelta: -quantity,
          stockAfter,
          note: transactionNumber,
          actorUserId: context.userId,
          deviceId: context.deviceId,
          recordVersion: 1,
          createdAt: now,
          updatedAt: now,
        });
      }

      if (input.paymentMethod === 'utang') {
        await db.utangEntries.add({
          id: crypto.randomUUID(),
          storeId: context.storeId,
          customerId: input.customerId!,
          saleId,
          kind: 'purchase',
          amount: total,
          note: transactionNumber,
          actorUserId: context.userId,
          recordVersion: 1,
          createdAt: now,
          updatedAt: now,
        });
      }
    });

    return { saleId, total, change };
  });
}

export async function saveProduct(input: {
  id?: string;
  name: string;
  category: string;
  barcode?: string;
  costPrice: number;
  sellingPrice: number;
  stockQuantity: number;
  unit: string;
  lowStockThreshold: number;
  isQuickItem: boolean;
  soldByWeight?: boolean;
  quantityStep?: number;
  image?: ProductImageInput | null;
}) {
  const context = await getStoreContext();
  const now = new Date().toISOString();
  const existing = input.id ? await db.products.get(input.id) : null;
  const normalizedBarcode = input.barcode?.trim() || null;
  if (normalizedBarcode) {
    const barcodeOwner = await db.products.where('barcode').equals(normalizedBarcode).first();
    if (barcodeOwner && barcodeOwner.id !== input.id) throw new Error('That barcode is already assigned to another product');
  }
  const imageRevision = input.image === undefined ? (existing?.imageRevision ?? null) : input.image?.revision ?? null;
  const soldByWeight = input.soldByWeight ?? existing?.soldByWeight ?? false;
  const quantityStep = soldByWeight ? (input.quantityStep ?? existing?.quantityStep ?? 0.01) : 1;
  if (!Number.isFinite(input.stockQuantity) || input.stockQuantity < 0) throw new Error('Stock quantity must be zero or more');
  if (!Number.isFinite(quantityStep) || quantityStep <= 0) throw new Error('Quantity step must be above zero');
  if (!soldByWeight && !Number.isInteger(input.stockQuantity)) throw new Error('Regular products require a whole-number stock quantity');
  if (soldByWeight && !isStepAligned(input.stockQuantity, quantityStep)) throw new Error(`Stock must use increments of ${quantityStep}`);

  const product: Product = {
    id: input.id ?? crypto.randomUUID(),
    storeId: context.storeId,
    barcode: normalizedBarcode,
    sku: existing?.sku ?? null,
    imageRevision,
    name: input.name.trim(),
    category: input.category.trim() || 'Other',
    costPrice: input.costPrice,
    sellingPrice: input.sellingPrice,
    stockQuantity: input.stockQuantity,
    unit: input.unit.trim() || 'piece',
    soldByWeight,
    quantityStep,
    lowStockThreshold: input.lowStockThreshold,
    isQuickItem: input.isQuickItem,
    isActive: existing?.isActive ?? true,
    recordVersion: existing ? existing.recordVersion + 1 : 1,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  const command: StoreCommand = {
    type: 'saveProduct',
    expectedVersion: existing?.recordVersion ?? null,
    payload: {
      id: existing?.id,
      barcode: normalizedBarcode,
      imageRevision,
      name: product.name,
      category: product.category,
      costPrice: product.costPrice,
      sellingPrice: product.sellingPrice,
      stockQuantity: product.stockQuantity,
      unit: product.unit,
      soldByWeight: product.soldByWeight,
      quantityStep: product.quantityStep,
      lowStockThreshold: product.lowStockThreshold,
      isQuickItem: product.isQuickItem,
      isActive: product.isActive,
    },
  };

  return applyLocalCommand(command, async () => {
    await db.transaction('rw', [db.products, db.productImages, db.productImageQueue], async () => {
      await db.products.put(product);
      if (input.image) {
        await db.productImages.put({
          productId: product.id,
          revision: input.image.revision,
          blob: input.image.blob,
          contentType: input.image.contentType,
          byteLength: input.image.blob.size,
          syncStatus: 'pending',
          updatedAt: now,
        });
        await db.productImageQueue.put({
          id: `upload:${product.id}:${input.image.revision}`,
          productId: product.id,
          revision: input.image.revision,
          operation: 'upload',
          attemptCount: 0,
          lastAttemptAt: null,
        });
      } else if (input.image === null) {
        await db.productImages.delete(product.id);
      }
      if (existing?.imageRevision && existing.imageRevision !== imageRevision) {
        await db.productImageQueue.put({
          id: `delete:${product.id}:${existing.imageRevision}`,
          productId: product.id,
          revision: existing.imageRevision,
          operation: 'delete',
          attemptCount: 0,
          lastAttemptAt: null,
        });
      }
    });
    return product;
  });
}

export async function adjustStock(product: Product, newQuantity: number, note: string) {
  validateStockQuantity(product, newQuantity);
  const context = await getStoreContext();
  const now = new Date().toISOString();
  const command: StoreCommand = {
    type: 'adjustStock',
    payload: {
      productId: product.id,
      newQuantity,
      note,
      expectedVersion: product.recordVersion,
    },
  };
  return applyLocalCommand(command, async () => {
    await db.transaction('rw', [db.products, db.inventoryMovements], async () => {
      const current = await db.products.get(product.id);
      if (!current) throw new Error('Product not found');
      validateStockQuantity(current, newQuantity);
      await db.products.update(current.id, { stockQuantity: newQuantity, updatedAt: now, recordVersion: current.recordVersion + 1 });
      await db.inventoryMovements.add({
        id: crypto.randomUUID(),
        storeId: context.storeId,
        productId: current.id,
        saleId: null,
        reason: newQuantity >= current.stockQuantity ? 'restock' : 'adjustment',
        quantityDelta: newQuantity - current.stockQuantity,
        stockAfter: newQuantity,
        note: note || null,
        actorUserId: context.userId,
        deviceId: context.deviceId,
        recordVersion: 1,
        createdAt: now,
        updatedAt: now,
      });
    });
  });
}

export async function restockProduct(product: Product, mode: RestockMode, quantity: number, note = 'Quick restock') {
  const requestedQuantity = quantity;
  const initialNextQuantity = mode === 'add' ? normalizeQuantity(product.stockQuantity + requestedQuantity) : requestedQuantity;
  validateStockQuantity(product, initialNextQuantity);
  const context = await getStoreContext();
  const now = new Date().toISOString();
  const command: StoreCommand = {
    type: 'restockProduct',
    payload: {
      productId: product.id,
      mode,
      quantity: requestedQuantity,
      note,
      expectedVersion: product.recordVersion,
    },
  };
  return applyLocalCommand(command, async () => {
    await db.transaction('rw', [db.products, db.inventoryMovements], async () => {
      const current = await db.products.get(product.id);
      if (!current) throw new Error('Product not found');
      const nextQuantity = mode === 'add' ? normalizeQuantity(current.stockQuantity + requestedQuantity) : requestedQuantity;
      validateStockQuantity(current, nextQuantity);
      await db.products.update(current.id, { stockQuantity: nextQuantity, updatedAt: now, recordVersion: current.recordVersion + 1 });
      await db.inventoryMovements.add({
        id: crypto.randomUUID(),
        storeId: context.storeId,
        productId: current.id,
        saleId: null,
        reason: nextQuantity >= current.stockQuantity ? 'restock' : 'adjustment',
        quantityDelta: nextQuantity - current.stockQuantity,
        stockAfter: nextQuantity,
        note: note || null,
        actorUserId: context.userId,
        deviceId: context.deviceId,
        recordVersion: 1,
        createdAt: now,
        updatedAt: now,
      });
    });
  });
}

export async function createCustomer(name: string) {
  const normalizedName = name.trim();
  if (!normalizedName) throw new Error('Enter a customer name');
  const existing = (await db.customers.toArray()).find((customer) => customer.isActive && customer.name.toLocaleLowerCase() === normalizedName.toLocaleLowerCase());
  if (existing) return existing;
  const context = await getStoreContext();
  const now = new Date().toISOString();
  const customer: Customer = {
    id: crypto.randomUUID(),
    storeId: context.storeId,
    name: normalizedName,
    nickname: null,
    phoneNumber: null,
    notes: null,
    isActive: true,
    recordVersion: 1,
    createdAt: now,
    updatedAt: now,
  };
  const command: StoreCommand = {
    type: 'createCustomer',
    payload: { name: normalizedName },
  };
  return applyLocalCommand(command, async () => {
    await db.customers.add(customer);
    return customer;
  });
}

export async function recordUtangPayment(customerId: string, amount: number, note = 'Payment received') {
  const context = await getStoreContext();
  const now = new Date().toISOString();
  const command: StoreCommand = {
    type: 'recordUtangPayment',
    payload: { customerId, amount, note },
  };
  return applyLocalCommand(command, async () => {
    await db.utangEntries.add({
      id: crypto.randomUUID(),
      storeId: context.storeId,
      customerId,
      saleId: null,
      kind: 'payment',
      amount,
      note,
      actorUserId: context.userId,
      recordVersion: 1,
      createdAt: now,
      updatedAt: now,
    });
  });
}

export async function recordExpense(input: Pick<Expense, 'category' | 'description' | 'amount' | 'occurredAt'>) {
  const context = await getStoreContext();
  const now = new Date().toISOString();
  const command: StoreCommand = {
    type: 'recordExpense',
    payload: input,
  };
  return applyLocalCommand(command, async () => {
    await db.expenses.add({
      ...input,
      id: crypto.randomUUID(),
      storeId: context.storeId,
      actorUserId: context.userId,
      recordVersion: 1,
      createdAt: now,
      updatedAt: now,
    });
  });
}

function prepareCartLine(entry: CartEntry, product: Product) {
  const pricingMode = entry.pricingMode ?? 'quantity';
  if (pricingMode === 'amount') {
    const enteredAmount = entry.enteredAmount ?? 0;
    if (!product.soldByWeight) throw new Error(`${product.name} cannot be sold by amount`);
    if (product.sellingPrice <= 0) throw new Error(`${product.name} needs a selling price before it can be sold by amount`);
    if (!Number.isInteger(enteredAmount) || enteredAmount <= 0) throw new Error(`Enter a valid peso amount for ${product.name}`);
    const maximumAmount = Math.floor(product.stockQuantity * product.sellingPrice);
    if (enteredAmount > maximumAmount) {
      throw new Error(`Only ${product.stockQuantity} ${product.unit} of ${product.name} remain (up to ₱${(maximumAmount / 100).toFixed(2)})`);
    }
    return { quantity: normalizeQuantity(enteredAmount / product.sellingPrice), subtotal: enteredAmount };
  }

  const quantity = entry.quantity;
  if (!Number.isFinite(quantity) || quantity <= 0) throw new Error(`Enter a valid quantity for ${product.name}`);
  const quantityStep = product.soldByWeight ? product.quantityStep : 1;
  if (!isStepAligned(quantity, quantityStep)) {
    throw new Error(`${product.name} must be sold in increments of ${quantityStep} ${product.unit}`);
  }
  if (product.stockQuantity < quantity) throw new Error(`Only ${product.stockQuantity} ${product.unit} of ${product.name} remain`);
  return { quantity, subtotal: Math.round(quantity * product.sellingPrice) };
}

function calculateChange(total: number, cashReceived: number) {
  if (cashReceived < total) return null;
  return cashReceived - total;
}
