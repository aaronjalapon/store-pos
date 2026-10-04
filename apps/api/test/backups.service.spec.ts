import { BackupsService } from '../src/backups/backups.service';

describe('BackupsService', () => {
  it('stores a server snapshot backup and reports summary metadata', async () => {
    const query = jest.fn(async (sql: string) => sql.includes('MAX(created_at)')
      ? { rows: [{ latest_backup_at: new Date('2026-08-12T00:00:00.000Z'), backup_count: '1' }] }
      : { rows: [] });
    const database = { query, transaction: async (work: (client: { query: typeof query }) => Promise<unknown>) => work({ query }) };
    const storage = { put: jest.fn().mockResolvedValue(undefined), copy: jest.fn().mockResolvedValue(undefined), delete: jest.fn().mockResolvedValue(undefined) };
    const data = { loadSnapshot: jest.fn().mockResolvedValue({ products: [], sales: [], saleItems: [], inventoryMovements: [], customers: [], utangEntries: [], expenses: [], staff: [] }) };
    const service = new BackupsService(database as never, storage as never, data as never);

    const principal = {
      userId: 'user',
      storeId: 'store',
      deviceId: 'device',
      role: 'owner' as const,
      displayName: 'Owner',
      email: 'owner@example.com',
      staffCode: null,
    };

    const summary = await service.create(principal);
    expect(storage.put).toHaveBeenCalled();
    expect(data.loadSnapshot).toHaveBeenCalledWith('store', { includeInactiveUnits: true, client: expect.objectContaining({ query }) });
    expect(summary).toEqual({ latestBackupAt: '2026-08-12T00:00:00.000Z', backupCount: 1 });
  });
});
