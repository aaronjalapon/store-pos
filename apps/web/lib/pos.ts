'use client';

import type {
  Customer,
  Expense,
  PaymentMethod,
  Product,
  ProductUnit,
  StoreCommand,
} from '@gma/contracts';
import { db, getStoreContext, queueCommand } from './db';
import { createCommandRequest, requestSync } from './api';

export interface ProductImageInput {
  revision: string;
  blob: Blob;
  contentType: 'image/webp' | 'image/jpeg';
}

export type ProductUnitInput = Omit<ProductUnit, 'id' | 'storeId' | 'productId' | 'createdAt' | 'updatedAt' | 'recordVersion'> & { id?: string };

export interface CartEntry {
  product: Product;
  quantity: number;
  unit?: ProductUnit | null;
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

function convertInputToBase(unit: ProductUnit, inputQuantity: number) {
  if (!Number.isFinite(inputQuantity) || inputQuantity <= 0 || !isStepAligned(inputQuantity, unit.quantityStep)) {
    throw new Error(`Quantity must use increments of ${unit.quantityStep} ${unit.name}`);
  }
  const base = inputQuantity * unit.multiplierBaseUnits;
  if (!Number.isSafeInteger(Math.round(base))) throw new Error('Quantity is too large');
  return Math.round(base);
}

async function applyLocalCommand<T>(command: StoreCommand, optimistic: () => Promise<T>) {
  const request = await createCommandRequest(command);
  const result = await db.transaction('rw', db.tables, async () => {
    const optimisticResult = await optimistic();
    await queueCommand(request);
    return optimisticResult;
  });
  window.dispatchEvent(new Event('pos-data-changed'));
  window.dispatchEvent(new Event('pos-sync-state-changed'));
  void requestSync();
  return result;
}

export async function completeSale(input: CompleteSaleInput) {
  if (!input.cart.length) throw new Error('Cart is empty');
  if (input.paymentMethod === 'utang' && !input.customerId) throw new Error('Select an utang customer');

  const context = await getStoreContext();
  const now = new Date().toISOString();
  const saleId = crypto.randomUUID();
  const transactionNumber = `POS-${now.slice(0, 10).replaceAll('-', '')}-${saleId.toUpperCase()}`;
  const command: StoreCommand = {
    type: 'completeSale',
    payload: {
      saleId,
      transactionNumber,
      occurredAt: now,
      paymentMethod: input.paymentMethod,
      cashReceived: input.cashReceived,
      customerId: input.customerId,
      cart: input.cart.map((line) => ({
        productId: line.product.id,
        quantity: line.quantity,
        productUnitId: line.unit?.id,
        inputQuantity: line.quantity,
        pricingMode: line.pricingMode ?? 'quantity',
        enteredAmount: line.enteredAmount ?? null,
        expectedVersion: line.product.recordVersion,
      })),
    },
  };

  return applyLocalCommand(command, async () => {
    const currentProducts = await db.products.bulkGet(input.cart.map(({ product }) => product.id));
    const currentUnits = await db.productUnits.bulkGet(input.cart.map(({ unit }) => unit?.id).filter((id): id is string => Boolean(id)));
    const unitMap = new Map(currentUnits.filter((unit): unit is ProductUnit => Boolean(unit)).map((unit) => [unit.id, unit]));
    const preparedLines = input.cart.map((entry, index) => {
      const current = currentProducts[index];
      if (!current?.isActive) throw new Error(`${entry.product.name} is no longer available`);
      const unit = entry.unit?.id ? unitMap.get(entry.unit.id) ?? entry.unit : undefined;
      return unit ? prepareCanonicalCartLine(entry, current, unit) : prepareCartLine(entry, current);
    });
    const subtotal = preparedLines.reduce((sum, line) => sum + line.subtotal, 0);
    const total = subtotal;
    const change = input.paymentMethod === 'cash' ? calculateChange(total, input.cashReceived ?? 0) : null;
    if (input.paymentMethod === 'cash' && change === null) throw new Error('Cash received is less than the total');

    await db.transaction('rw', [db.products, db.productUnits, db.sales, db.saleItems, db.inventoryMovements, db.utangEntries], async () => {
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

      const runningBase = new Map<string, number>();
      for (let index = 0; index < input.cart.length; index += 1) {
        const { quantity, subtotal: lineSubtotal } = preparedLines[index];
        const product = currentProducts[index]!;
        const unit = preparedLines[index].unit;
        const baseQuantity = preparedLines[index].baseQuantity;
        const stockAfterBase = unit
          ? (runningBase.get(product.id) ?? product.stockBaseQuantity ?? product.stockQuantity) - baseQuantity!
          : null;
        runningBase.set(product.id, unit ? stockAfterBase! : runningBase.get(product.id) ?? product.stockBaseQuantity ?? product.stockQuantity);
        const stockAfter = unit
          ? normalizeQuantity(stockAfterBase! / legacyDisplayMultiplier(product))
          : normalizeQuantity(product.stockQuantity - quantity);
        await db.products.update(product.id, {
          stockQuantity: stockAfter,
          ...(unit ? { stockBaseQuantity: stockAfterBase as number } : {}),
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
          unitPrice: unit?.sellingPrice ?? product.sellingPrice,
          costPriceSnapshot: unit?.costPrice ?? product.costPrice,
          subtotal: lineSubtotal,
          productUnitId: unit?.id ?? null,
          inputQuantity: preparedLines[index].inputQuantity ?? quantity,
          unitNameSnapshot: unit?.name ?? product.unit,
          unitSymbolSnapshot: unit?.symbol ?? product.unit,
          multiplierBaseUnitsSnapshot: unit?.multiplierBaseUnits ?? 1,
          baseQuantity: baseQuantity ?? Math.round(quantity),
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
          productUnitId: unit?.id ?? null,
          inputMode: 'delta',
          inputQuantity: preparedLines[index].inputQuantity ?? quantity,
          inputUnitSnapshot: unit?.name ?? product.unit,
          multiplierBaseUnitsSnapshot: unit?.multiplierBaseUnits ?? 1,
          baseQuantityDelta: unit ? -baseQuantity! : -quantity,
          stockAfterBase: unit ? stockAfterBase! : undefined,
          actorDisplayNameSnapshot: context.session.user.displayName,
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
  units?: ProductUnitInput[];
  stockBaseQuantity?: number;
  lowStockBaseThreshold?: number;
  defaultSaleUnitId?: string | null;
  defaultRestockUnitId?: string | null;
  displayUnitId?: string | null;
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
    ...(input.units?.length ? {
      baseUnit: input.units.find((unit) => unit.isBase)?.name ?? input.unit,
      baseUnitId: input.units.find((unit) => unit.isBase)?.id ?? null,
      stockBaseQuantity: input.stockBaseQuantity ?? input.stockQuantity,
      lowStockBaseThreshold: input.lowStockBaseThreshold ?? input.lowStockThreshold,
      defaultSaleUnitId: input.defaultSaleUnitId ?? input.units.find((unit) => unit.canSell)?.id ?? null,
      defaultRestockUnitId: input.defaultRestockUnitId ?? input.units.find((unit) => unit.canRestock)?.id ?? null,
      displayUnitId: input.displayUnitId ?? input.units.find((unit) => unit.canSell)?.id ?? null,
    } : {}),
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
      baseUnit: product.baseUnit,
      stockBaseQuantity: product.stockBaseQuantity,
      lowStockBaseThreshold: product.lowStockBaseThreshold,
      defaultSaleUnitId: product.defaultSaleUnitId,
      defaultRestockUnitId: product.defaultRestockUnitId,
      displayUnitId: product.displayUnitId,
      units: input.units,
    },
  };
  const unitRows: ProductUnit[] = (input.units ?? []).map((unit) => ({
    ...unit,
    id: unit.id ?? crypto.randomUUID(),
    storeId: context.storeId,
    productId: product.id,
    recordVersion: 1,
    createdAt: existing?.updatedAt ?? now,
    updatedAt: now,
  }));

  return applyLocalCommand(command, async () => {
    await db.transaction('rw', [db.products, db.productUnits, db.productImages, db.productImageQueue], async () => {
      await db.products.put(product);
      if (unitRows.length) await db.productUnits.bulkPut(unitRows);
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

export async function receiveStock(product: Product, unit: ProductUnit, inputQuantity: number, note = 'Stock received') {
  if (!unit.canRestock) throw new Error(`${unit.name} cannot be used for receiving stock`);
  const baseDelta = convertInputToBase(unit, inputQuantity);
  const context = await getStoreContext();
  const now = new Date().toISOString();
  return applyLocalCommand({
    type: 'receiveStock',
    payload: { productId: product.id, productUnitId: unit.id, inputQuantity, note },
  }, async () => {
    const current = await db.products.get(product.id);
    if (!current) throw new Error('Product not found');
    const nextBase = (current.stockBaseQuantity ?? current.stockQuantity) + baseDelta;
    await db.transaction('rw', [db.products, db.inventoryMovements], async () => {
      await db.products.update(current.id, { stockBaseQuantity: nextBase, stockQuantity: normalizeQuantity(nextBase / legacyDisplayMultiplier(current)), updatedAt: now, recordVersion: current.recordVersion + 1 });
      await db.inventoryMovements.add({
        id: crypto.randomUUID(), storeId: context.storeId, productId: current.id, saleId: null, reason: 'restock',
        quantityDelta: baseDelta, stockAfter: nextBase, note, actorUserId: context.userId, deviceId: context.deviceId,
        productUnitId: unit.id, inputMode: 'delta', inputQuantity, inputUnitSnapshot: unit.name,
        multiplierBaseUnitsSnapshot: unit.multiplierBaseUnits, baseQuantityDelta: baseDelta, stockAfterBase: nextBase,
        actorDisplayNameSnapshot: context.session.user.displayName, recordVersion: 1, createdAt: now, updatedAt: now,
      });
    });
  });
}

export async function countStock(product: Product, unit: ProductUnit, inputQuantity: number, reason: NonNullable<import('@gma/contracts').InventoryMovement['adjustmentReason']>, note = 'Physical stock count') {
  if (!unit.canRestock) throw new Error(`${unit.name} cannot be used for stock counting`);
  const countedBase = inputQuantity === 0 ? 0 : convertInputToBase(unit, inputQuantity);
  const context = await getStoreContext();
  const now = new Date().toISOString();
  return applyLocalCommand({ type: 'countStock', payload: { productId: product.id, productUnitId: unit.id, inputQuantity, reason, note, expectedVersion: product.recordVersion } }, async () => {
    const current = await db.products.get(product.id);
    if (!current) throw new Error('Product not found');
    const currentBase = current.stockBaseQuantity ?? current.stockQuantity;
    const delta = countedBase - currentBase;
    await db.transaction('rw', [db.products, db.inventoryMovements], async () => {
      await db.products.update(current.id, { stockBaseQuantity: countedBase, stockQuantity: normalizeQuantity(countedBase / legacyDisplayMultiplier(current)), updatedAt: now, recordVersion: current.recordVersion + 1 });
      await db.inventoryMovements.add({ id: crypto.randomUUID(), storeId: context.storeId, productId: current.id, saleId: null, reason: 'adjustment', quantityDelta: delta, stockAfter: countedBase, note, actorUserId: context.userId, deviceId: context.deviceId, productUnitId: unit.id, inputMode: 'absolute', inputQuantity, inputUnitSnapshot: unit.name, multiplierBaseUnitsSnapshot: unit.multiplierBaseUnits, baseQuantityDelta: delta, stockAfterBase: countedBase, adjustmentReason: reason, actorDisplayNameSnapshot: context.session.user.displayName, recordVersion: 1, createdAt: now, updatedAt: now });
    });
  });
}

export async function adjustStockDelta(product: Product, unit: ProductUnit, inputQuantity: number, reason: NonNullable<import('@gma/contracts').InventoryMovement['adjustmentReason']>, note = 'Inventory adjustment') {
  if (!inputQuantity) throw new Error('Adjustment quantity cannot be zero');
  const magnitude = convertInputToBase(unit, Math.abs(inputQuantity));
  const baseDelta = Math.sign(inputQuantity) * magnitude;
  const context = await getStoreContext();
  const now = new Date().toISOString();
  return applyLocalCommand({ type: 'adjustStockDelta', payload: { productId: product.id, productUnitId: unit.id, inputQuantity, reason, note } }, async () => {
    const current = await db.products.get(product.id);
    if (!current) throw new Error('Product not found');
    const currentBase = current.stockBaseQuantity ?? current.stockQuantity;
    const nextBase = currentBase + baseDelta;
    if (nextBase < 0) throw new Error('Adjustment would make stock negative');
    await db.transaction('rw', [db.products, db.inventoryMovements], async () => {
      await db.products.update(current.id, { stockBaseQuantity: nextBase, stockQuantity: normalizeQuantity(nextBase / legacyDisplayMultiplier(current)), updatedAt: now, recordVersion: current.recordVersion + 1 });
      await db.inventoryMovements.add({ id: crypto.randomUUID(), storeId: context.storeId, productId: current.id, saleId: null, reason: 'adjustment', quantityDelta: baseDelta, stockAfter: nextBase, note, actorUserId: context.userId, deviceId: context.deviceId, productUnitId: unit.id, inputMode: 'delta', inputQuantity: Math.abs(inputQuantity), inputUnitSnapshot: unit.name, multiplierBaseUnitsSnapshot: unit.multiplierBaseUnits, baseQuantityDelta: baseDelta, stockAfterBase: nextBase, adjustmentReason: reason, actorDisplayNameSnapshot: context.session.user.displayName, recordVersion: 1, createdAt: now, updatedAt: now });
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
    const quantity = normalizeQuantity(enteredAmount / product.sellingPrice);
    return { quantity, inputQuantity: quantity, baseQuantity: undefined, unit: undefined, subtotal: enteredAmount };
  }

  const quantity = entry.quantity;
  if (!Number.isFinite(quantity) || quantity <= 0) throw new Error(`Enter a valid quantity for ${product.name}`);
  const quantityStep = product.soldByWeight ? product.quantityStep : 1;
  if (!isStepAligned(quantity, quantityStep)) {
    throw new Error(`${product.name} must be sold in increments of ${quantityStep} ${product.unit}`);
  }
  if (product.stockQuantity < quantity) throw new Error(`Only ${product.stockQuantity} ${product.unit} of ${product.name} remain`);
  return { quantity, inputQuantity: quantity, baseQuantity: undefined, unit: undefined, subtotal: Math.round(quantity * product.sellingPrice) };
}

function prepareCanonicalCartLine(entry: CartEntry, product: Product, unit: ProductUnit) {
  if (!unit.canSell || unit.sellingPrice == null) throw new Error(`${product.name} cannot be sold using ${unit.name}`);
  const pricingMode = entry.pricingMode ?? 'quantity';
  if (pricingMode === 'amount') {
    if (!unit.allowAmountPricing || unit.sellingPrice <= 0) throw new Error(`${unit.name} cannot be sold by amount`);
    const enteredAmount = entry.enteredAmount ?? 0;
    if (!Number.isInteger(enteredAmount) || enteredAmount <= 0) throw new Error('Enter a valid peso amount');
    const increment = Math.round(unit.multiplierBaseUnits * unit.quantityStep);
    const baseQuantity = Math.floor(((enteredAmount / unit.sellingPrice) * unit.multiplierBaseUnits) / increment + 0.5) * increment;
    const available = product.stockBaseQuantity ?? product.stockQuantity;
    if (baseQuantity <= 0) throw new Error('Peso amount is below the minimum sale increment');
    if (baseQuantity > available) throw new Error(`Only ${available} base units of ${product.name} remain`);
    const quantity = normalizeQuantity(baseQuantity / unit.multiplierBaseUnits);
    return { quantity, inputQuantity: quantity, baseQuantity, unit, subtotal: enteredAmount };
  }
  const quantity = entry.quantity;
  if (!Number.isFinite(quantity) || quantity <= 0 || !isStepAligned(quantity, unit.quantityStep)) {
    throw new Error(`${product.name} must be sold in increments of ${unit.quantityStep} ${unit.name}`);
  }
  const baseQuantity = Math.round(quantity * unit.multiplierBaseUnits);
  const available = product.stockBaseQuantity ?? product.stockQuantity;
  if (baseQuantity > available) throw new Error(`Only ${available} base units of ${product.name} remain`);
  return { quantity, inputQuantity: quantity, baseQuantity, unit, subtotal: Math.round(quantity * unit.sellingPrice) };
}

function legacyDisplayMultiplier(product: Product) {
  const unit = product.unit.trim().toLowerCase();
  return unit === 'kg' || unit === 'kilogram' || unit === 'liter' || unit === 'litre' ? 1000 : 1;
}

function calculateChange(total: number, cashReceived: number) {
  if (cashReceived < total) return null;
  return cashReceived - total;
}
