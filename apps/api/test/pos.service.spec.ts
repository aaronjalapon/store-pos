import type { StoreCommandRequest } from '@gma/contracts';
import { PosService } from '../src/pos/pos.service';

const principal = {
  userId: 'user', storeId: 'store', deviceId: 'device', role: 'cashier' as const,
  displayName: 'Cashier', email: null, staffCode: 'CASHIER',
};

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
      loadSnapshot: jest.fn().mockResolvedValue(emptySnapshot),
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
      loadSnapshot: jest.fn().mockResolvedValue(emptySnapshot),
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
