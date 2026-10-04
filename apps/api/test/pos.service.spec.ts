import type { StoreCommandRequest } from '@gma/contracts';
import { PosService } from '../src/pos/pos.service';

const principal = {
  userId: 'user', storeId: 'store', deviceId: 'device', role: 'cashier' as const,
  displayName: 'Cashier', email: null, staffCode: 'CASHIER',
};

const ownerPrincipal = { ...principal, role: 'owner' as const };

const emptySnapshot = {
  products: [], sales: [], saleItems: [], inventoryMovements: [], customers: [], utangEntries: [], expenses: [],
};

describe('PosService command idempotency', () => {
  it('returns a previously recorded result without applying the command again', async () => {
    const client = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ result_json: { saleId: 'same-sale', message: 'Sale completed.' } }] }),
    };
    const database = {
      query: jest.fn().mockResolvedValue({ rows: [{ first_synced_at: new Date() }] }),
      transaction: jest.fn(async (work: (value: typeof client) => Promise<unknown>) => work(client)),
    };
    const data = {
      loadBrowserSnapshot: jest.fn().mockResolvedValue(emptySnapshot),
      currentCursor: jest.fn().mockResolvedValue(12),
      createSyncEvent: jest.fn(),
    };
    const service = new PosService(database as never, data as never);
    const request = {
      clientCommandId: '00000000-0000-4000-8000-000000000001', baseCursor: 0,
      command: {
        type: 'completeSale',
        payload: {
          saleId: '00000000-0000-4000-8000-000000000002', transactionNumber: 'POS-LOCAL', occurredAt: new Date().toISOString(),
          paymentMethod: 'cash', cashReceived: 100, customerId: null,
          cart: [{ productId: '00000000-0000-4000-8000-000000000003', quantity: 1, expectedVersion: 1 }],
        },
      },
    } satisfies StoreCommandRequest;

    await expect(service.applyCommand(principal, request)).resolves.toMatchObject({
      status: 'applied', cursor: 12, saleId: 'same-sale', message: 'Sale completed.',
    });
    expect(client.query).toHaveBeenCalledTimes(2);
    expect(data.createSyncEvent).not.toHaveBeenCalled();
  });

  it('records a new command result in the same database transaction', async () => {
    const client = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [{ client_command_id: 'new-command' }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] }),
    };
    const database = {
      query: jest.fn().mockResolvedValue({ rows: [{ first_synced_at: new Date() }] }),
      transaction: jest.fn(async (work: (value: typeof client) => Promise<unknown>) => work(client)),
    };
    const data = {
      loadBrowserSnapshot: jest.fn().mockResolvedValue(emptySnapshot),
      currentCursor: jest.fn().mockResolvedValue(13),
      createSyncEvent: jest.fn().mockResolvedValue(undefined),
    };
    const service = new PosService(database as never, data as never);
    const request = {
      clientCommandId: '00000000-0000-4000-8000-000000000004', baseCursor: 0,
      command: { type: 'createCustomer', payload: { name: 'Nena' } },
    } satisfies StoreCommandRequest;

    await expect(service.applyCommand(principal, request)).resolves.toMatchObject({ status: 'applied', cursor: 13 });
    expect(database.transaction).toHaveBeenCalledTimes(1);
    expect(data.createSyncEvent).toHaveBeenCalledTimes(1);
    expect(client.query.mock.calls[3][0]).toContain('UPDATE processed_commands');
  });
});

describe('PosService sale integrity', () => {
  const productId = '00000000-0000-4000-8000-000000000071';
  const otherProductId = '00000000-0000-4000-8000-000000000072';
  const unitId = '00000000-0000-4000-8000-000000000073';
  const productRow = {
    id: productId, store_id: principal.storeId, name: 'Rice', unit: 'piece', barcode: null, sku: null,
    image_revision: null, cost_price: 500, selling_price: 700, stock_quantity: 10,
    sold_by_weight: false, quantity_step: 1, low_stock_threshold: 2, is_quick_item: true,
    is_active: true, record_version: 1, created_at: new Date(), updated_at: new Date(),
    base_unit: 'piece', base_unit_id: null, stock_base_quantity: 10, low_stock_base_threshold: 2,
    default_sale_unit_id: null, default_restock_unit_id: null, display_unit_id: null,
  };

  function request(cart: Array<{ productId: string; quantity: number; expectedVersion: number; productUnitId?: string; inputQuantity?: number }>): StoreCommandRequest {
    return {
      clientCommandId: crypto.randomUUID(), baseCursor: 0,
      command: {
        type: 'completeSale',
        payload: {
          saleId: crypto.randomUUID(), transactionNumber: 'POS-TEST', occurredAt: new Date().toISOString(),
          paymentMethod: 'cash', cashReceived: 10_000, customerId: null, cart,
        },
      },
    };
  }

  function serviceWith(client: { query: jest.Mock }) {
    const database = {
      query: jest.fn().mockResolvedValue({ rows: [{ first_synced_at: new Date() }] }),
      transaction: jest.fn(async (work: (value: typeof client) => Promise<unknown>) => work(client)),
    };
    const data = { loadBrowserSnapshot: jest.fn().mockResolvedValue(emptySnapshot), currentCursor: jest.fn().mockResolvedValue(20), createSyncEvent: jest.fn() };
    return { service: new PosService(database as never, data as never), data };
  }

  it('rejects a selling unit owned by another product', async () => {
    const client = { query: jest.fn(async (sql: string, _parameters?: unknown[]) => {
      if (sql.includes('INSERT INTO processed_commands')) return { rows: [{ client_command_id: 'claim' }] };
      if (sql.includes('SELECT * FROM products')) return { rows: [productRow] };
      if (sql.includes('SELECT * FROM product_units')) return { rows: [{
        id: unitId, store_id: principal.storeId, product_id: otherProductId, name: 'case', symbol: 'case',
        multiplier_base_units: 24, quantity_step: 1, can_sell: true, can_restock: true,
        allow_amount_pricing: false, selling_price: 12_000, cost_price: 10_000, barcode: null,
        is_base: false, is_active: true, replaces_unit_id: null, record_version: 1, created_at: new Date(), updated_at: new Date(),
      }] };
      return { rows: [] };
    }) };
    const { service } = serviceWith(client);
    await expect(service.applyCommand(principal, request([{ productId, productUnitId: unitId, inputQuantity: 1, quantity: 1, expectedVersion: 1 }]))).resolves.toMatchObject({ status: 'conflict', reason: 'unit_product_mismatch' });
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO sales'))).toBe(false);
  });

  it('aggregates duplicate legacy lines before checking stock', async () => {
    const client = { query: jest.fn(async (sql: string, _parameters?: unknown[]) => {
      if (sql.includes('INSERT INTO processed_commands')) return { rows: [{ client_command_id: 'claim' }] };
      if (sql.includes('SELECT * FROM products')) return { rows: [{ ...productRow, stock_quantity: 5, stock_base_quantity: 5 }] };
      return { rows: [] };
    }) };
    const { service } = serviceWith(client);
    await expect(service.applyCommand(principal, request([
      { productId, quantity: 3, expectedVersion: 1 }, { productId, quantity: 3, expectedVersion: 1 },
    ]))).resolves.toMatchObject({ status: 'conflict', reason: 'stale_product' });
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes('UPDATE products'))).toBe(false);
  });

  it('updates each product stock balance exactly once for duplicate lines', async () => {
    const client = { query: jest.fn(async (sql: string, _parameters?: unknown[]) => {
      if (sql.includes('INSERT INTO processed_commands')) return { rows: [{ client_command_id: 'claim' }] };
      if (sql.includes('SELECT * FROM products')) return { rows: [productRow] };
      return { rows: [] };
    }) };
    const { service } = serviceWith(client);
    await expect(service.applyCommand(principal, request([
      { productId, quantity: 2, expectedVersion: 1 }, { productId, quantity: 2, expectedVersion: 1 },
    ]))).resolves.toMatchObject({ status: 'applied' });
    const updates = client.query.mock.calls.filter(([sql]) => String(sql).includes('UPDATE products'));
    expect(updates).toHaveLength(1);
    expect(updates[0][1]).toEqual([productId, principal.storeId, 6, expect.any(String), principal.userId, 6]);
  });
});

describe('PosService protected stock adjustment', () => {
  const request = {
    clientCommandId: '00000000-0000-4000-8000-000000000061',
    baseCursor: 0,
    managerApprovalProof: 'manager-proof',
    command: {
      type: 'adjustStock' as const,
      payload: {
        productId: '00000000-0000-4000-8000-000000000062',
        newQuantity: 12,
        note: 'Manual stock adjustment',
        expectedVersion: 1,
      },
    },
  } satisfies StoreCommandRequest;

  it('rejects a cashier before processing or checking a password proof', async () => {
    const database = { query: jest.fn() };
    const auth = { verifyManagerActionProof: jest.fn() };
    const service = new PosService(database as never, {} as never, auth as never);

    await expect(service.applyCommand(principal, request)).rejects.toThrow('You do not have access to this action');
    expect(auth.verifyManagerActionProof).not.toHaveBeenCalled();
    expect(database.query).not.toHaveBeenCalled();
  });

  it('requires a command-bound manager approval before touching stock', async () => {
    const database = { query: jest.fn().mockResolvedValue({ rows: [{ first_synced_at: null }] }) };
    const data = {
      loadBrowserSnapshot: jest.fn().mockResolvedValue(emptySnapshot),
      currentCursor: jest.fn().mockResolvedValue(0),
    };
    const auth = { verifyManagerActionProof: jest.fn().mockResolvedValue(undefined) };
    const service = new PosService(database as never, data as never, auth as never);

    await service.applyCommand(ownerPrincipal, request);
    expect(auth.verifyManagerActionProof).toHaveBeenCalledWith(
      ownerPrincipal,
      'manager-proof',
      'adjust_stock',
      request.clientCommandId,
    );
  });
});

describe('PosService product persistence', () => {
  it('creates a canonical product with required base inventory values and a type-safe barcode check', async () => {
    const client = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [{ client_command_id: 'new-command' }] })
        .mockResolvedValue({ rows: [] }),
    };
    const database = {
      query: jest.fn().mockResolvedValue({ rows: [{ first_synced_at: new Date() }] }),
      transaction: jest.fn(async (work: (value: typeof client) => Promise<unknown>) => work(client)),
    };
    const data = {
      loadBrowserSnapshot: jest.fn().mockResolvedValue(emptySnapshot),
      currentCursor: jest.fn().mockResolvedValue(14),
      createSyncEvent: jest.fn().mockResolvedValue(undefined),
    };
    const service = new PosService(database as never, data as never);
    const baseUnitId = '00000000-0000-4000-8000-000000000011';
    const request = {
      clientCommandId: '00000000-0000-4000-8000-000000000012', baseCursor: 0,
      command: {
        type: 'saveProduct', expectedVersion: null,
        payload: {
          barcode: '4800000000000', imageRevision: null, name: 'Hotdog', category: 'Frozen',
          costPrice: 900, sellingPrice: 1100, stockQuantity: 36, unit: 'piece', soldByWeight: false,
          quantityStep: 1, lowStockThreshold: 5, isQuickItem: true, isActive: true,
          baseUnit: 'piece', stockBaseQuantity: 36, lowStockBaseThreshold: 5,
          defaultSaleUnitId: baseUnitId, defaultRestockUnitId: baseUnitId, displayUnitId: baseUnitId,
          units: [{
            id: baseUnitId, name: 'piece', symbol: 'pc', multiplierBaseUnits: 1, quantityStep: 1,
            canSell: true, canRestock: true, allowAmountPricing: false, sellingPrice: 1100,
            costPrice: 900, barcode: '4800000000000', isBase: true, isActive: true, replacesUnitId: null,
          }],
        },
      },
    } satisfies StoreCommandRequest;

    await expect(service.applyCommand(ownerPrincipal, request)).resolves.toMatchObject({
      status: 'applied', cursor: 14, message: 'Product created.',
    });

    const barcodeCall = client.query.mock.calls.find(([sql]) => String(sql).includes('barcode = $2'));
    expect(barcodeCall).toBeDefined();
    expect(barcodeCall![0]).toContain('($3::uuid IS NULL OR id <> $3::uuid)');
    expect(barcodeCall![1]).toEqual([ownerPrincipal.storeId, '4800000000000', null]);

    const insertCall = client.query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO products'));
    expect(insertCall).toBeDefined();
    expect(insertCall![0]).toContain('base_unit, stock_base_quantity, low_stock_base_threshold');
    expect(insertCall![1]).toEqual(expect.arrayContaining(['piece', 36, 5]));
    expect(insertCall![1].slice(-3)).toEqual(['piece', 36, 5]);
  });

  it('allows an existing product to keep its own barcode', async () => {
    const productId = '00000000-0000-4000-8000-000000000020';
    const client = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [{ client_command_id: 'update-command' }] })
        .mockResolvedValueOnce({ rows: [{ id: productId, name: 'Hotdog', record_version: 1, image_revision: null }] })
        .mockResolvedValue({ rows: [] }),
    };
    const database = {
      query: jest.fn().mockResolvedValue({ rows: [{ first_synced_at: new Date() }] }),
      transaction: jest.fn(async (work: (value: typeof client) => Promise<unknown>) => work(client)),
    };
    const data = {
      loadBrowserSnapshot: jest.fn().mockResolvedValue(emptySnapshot),
      currentCursor: jest.fn().mockResolvedValue(15),
      createSyncEvent: jest.fn().mockResolvedValue(undefined),
    };
    const service = new PosService(database as never, data as never);
    const request = {
      clientCommandId: '00000000-0000-4000-8000-000000000021', baseCursor: 0,
      command: {
        type: 'saveProduct', expectedVersion: 1,
        payload: {
          id: productId, barcode: '4800000000000', imageRevision: null, name: 'Hotdog', category: 'Frozen',
          costPrice: 900, sellingPrice: 1100, stockQuantity: 36, unit: 'piece', soldByWeight: false,
          quantityStep: 1, lowStockThreshold: 5, isQuickItem: true, isActive: true,
        },
      },
    } satisfies StoreCommandRequest;

    await expect(service.applyCommand(ownerPrincipal, request)).resolves.toMatchObject({
      status: 'applied', cursor: 15, message: 'Product updated.',
    });
    const barcodeCall = client.query.mock.calls.find(([sql]) => String(sql).includes('barcode = $2'));
    expect(barcodeCall![1]).toEqual([ownerPrincipal.storeId, '4800000000000', productId]);
  });

  it('rejects a barcode already assigned to another product', async () => {
    const client = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [{ client_command_id: 'duplicate-command' }] })
        .mockResolvedValueOnce({ rows: [{ id: '00000000-0000-4000-8000-000000000031' }] }),
    };
    const database = {
      query: jest.fn().mockResolvedValue({ rows: [{ first_synced_at: new Date() }] }),
      transaction: jest.fn(async (work: (value: typeof client) => Promise<unknown>) => work(client)),
    };
    const data = {
      loadBrowserSnapshot: jest.fn().mockResolvedValue(emptySnapshot),
      currentCursor: jest.fn().mockResolvedValue(16),
      createSyncEvent: jest.fn(),
    };
    const service = new PosService(database as never, data as never);
    const request = {
      clientCommandId: '00000000-0000-4000-8000-000000000032', baseCursor: 0,
      command: {
        type: 'saveProduct', expectedVersion: null,
        payload: {
          barcode: '4800000000000', imageRevision: null, name: 'Duplicate hotdog', category: 'Frozen',
          costPrice: 900, sellingPrice: 1100, stockQuantity: 36, unit: 'piece', soldByWeight: false,
          quantityStep: 1, lowStockThreshold: 5, isQuickItem: true, isActive: true,
        },
      },
    } satisfies StoreCommandRequest;

    await expect(service.applyCommand(ownerPrincipal, request)).rejects.toThrow('already assigned');
    expect(data.createSyncEvent).not.toHaveBeenCalled();
  });
});

describe('PosService canonical inventory receiving', () => {
  it('converts bulk input to base stock and persists the selected unit snapshot', async () => {
    const productId = '00000000-0000-4000-8000-000000000041';
    const unitId = '00000000-0000-4000-8000-000000000042';
    const productRow = {
      id: productId, store_id: ownerPrincipal.storeId, name: 'Bottled drink', unit: 'piece',
      stock_quantity: 5, stock_base_quantity: 5, record_version: 1, is_active: true,
    };
    const unitRow = {
      id: unitId, store_id: ownerPrincipal.storeId, product_id: productId, name: 'case', symbol: 'case',
      multiplier_base_units: 24, quantity_step: 1, can_sell: true, can_restock: true,
      allow_amount_pricing: false, selling_price: 20000, cost_price: 15000, barcode: 'CASE-24',
      is_base: false, is_active: true, replaces_unit_id: null, record_version: 1,
    };
    const client = {
      query: jest.fn(async (sql: string, _params?: unknown[]) => {
        if (sql.includes('INSERT INTO processed_commands')) return { rows: [{ client_command_id: 'receive-command' }] };
        if (sql.includes('SELECT * FROM products')) return { rows: [productRow] };
        if (sql.includes('SELECT * FROM product_units')) return { rows: [unitRow] };
        return { rows: [] };
      }),
    };
    const database = {
      query: jest.fn().mockResolvedValue({ rows: [{ first_synced_at: new Date() }] }),
      transaction: jest.fn(async (work: (value: typeof client) => Promise<unknown>) => work(client)),
    };
    const data = {
      loadBrowserSnapshot: jest.fn().mockResolvedValue(emptySnapshot),
      currentCursor: jest.fn().mockResolvedValue(17),
      createSyncEvent: jest.fn().mockResolvedValue(undefined),
    };
    const service = new PosService(database as never, data as never);
    const request = {
      clientCommandId: '00000000-0000-4000-8000-000000000043', baseCursor: 0,
      command: {
        type: 'receiveStock',
        payload: { productId, productUnitId: unitId, inputQuantity: 2, note: 'Stock received' },
      },
    } satisfies StoreCommandRequest;

    await expect(service.applyCommand(ownerPrincipal, request)).resolves.toMatchObject({
      status: 'applied', cursor: 17, message: 'Stock received.',
    });
    const stockUpdate = client.query.mock.calls.find(([sql]) => String(sql).includes('SET stock_base_quantity'));
    expect(stockUpdate?.[1]).toEqual([productId, ownerPrincipal.storeId, 53, expect.any(String), ownerPrincipal.userId, 53]);
    const movementInsert = client.query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO inventory_movements'));
    expect(movementInsert?.[1]).toEqual(expect.arrayContaining([
      ownerPrincipal.storeId, productId, 'restock', 48, 53, unitId, 'delta', 2, 'case', 24,
    ]));
    expect(data.createSyncEvent).toHaveBeenCalledWith(client, ownerPrincipal.storeId, 'inventory');
  });
});
