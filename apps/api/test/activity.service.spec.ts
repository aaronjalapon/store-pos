import { ForbiddenException } from '@nestjs/common';
import type { StoreCommandRequest } from '@gma/contracts';
import { ActivityController } from '../src/activity/activity.controller';
import { ActivityService } from '../src/activity/activity.service';
import { PosService } from '../src/pos/pos.service';

const owner = {
  userId: '00000000-0000-4000-8000-000000000001',
  storeId: '00000000-0000-4000-8000-000000000002',
  deviceId: '00000000-0000-4000-8000-000000000003',
  role: 'owner' as const,
  displayName: 'Store Owner',
  email: 'owner@example.com',
  staffCode: null,
};

describe('ActivityService', () => {
  it('returns filtered newest-first pages with a next cursor', async () => {
    const row = (id: string) => ({
      id, store_id: owner.storeId, actor_user_id: owner.userId,
      actor_display_name_snapshot: owner.displayName, actor_role_snapshot: owner.role,
      submitted_by_user_id: null, submitted_by_display_name_snapshot: null, submitted_by_role_snapshot: null,
      device_id: owner.deviceId, device_name_snapshot: 'Front counter', category: 'sales', action: 'sale.completed',
      entity_type: 'sale', entity_id: id, summary: `Sale ${id}`, details: { total: 1000 },
      client_command_id: null, occurred_at: new Date('2026-10-01T01:00:00Z'), confirmed_at: new Date('2026-10-01T01:00:01Z'),
    });
    const database = { query: jest.fn().mockResolvedValue({ rows: [row('3'), row('2'), row('1')] }) };
    const service = new ActivityService(database as never);

    const result = await service.list(owner.storeId, { limit: 2, category: 'sales', role: 'owner', q: 'Sale' });

    expect(result.activity.map((item) => item.id)).toEqual(['3', '2']);
    expect(result.nextCursor).toBe('2');
    expect(database.query.mock.calls[0][0]).toContain('ORDER BY id DESC');
    expect(database.query.mock.calls[0][1]).toEqual([owner.storeId, 'sales', 'owner', '%Sale%', 3]);
  });

  it('records actor and submitter snapshots without credentials', async () => {
    const client = { query: jest.fn().mockResolvedValueOnce({ rows: [{ name: 'Front counter' }] }).mockResolvedValueOnce({ rows: [] }) };
    const service = new ActivityService({} as never);
    const submitter = { ...owner, userId: '00000000-0000-4000-8000-000000000004', displayName: 'Admin', role: 'admin' as const };

    await service.record(client as never, {
      storeId: owner.storeId, actor: owner, submittedBy: submitter, category: 'staff', action: 'staff.credential_reset',
      entityType: 'user', entityId: submitter.userId, summary: 'Reset cashier PIN', details: { credentialType: 'pin' },
    });

    const values = client.query.mock.calls[1][1] as unknown[];
    expect(values).toEqual(expect.arrayContaining([owner.displayName, owner.role, submitter.displayName, submitter.role, 'Front counter']));
    expect(JSON.stringify(values)).not.toMatch(/password|token|hash/i);
  });
});

describe('ActivityController scope', () => {
  it('rejects a manager requesting another store', async () => {
    const controller = new ActivityController({ list: jest.fn() } as never);
    expect(() => controller.list({ principal: owner } as never, '00000000-0000-4000-8000-000000000099', {})).toThrow(ForbiddenException);
  });
});

describe('PosService activity attribution', () => {
  it('uses the signed originating actor and records the authenticated submitter', async () => {
    const actor = { ...owner, userId: '00000000-0000-4000-8000-000000000010', displayName: 'Original Admin', role: 'admin' as const };
    const submitter = { ...owner, userId: '00000000-0000-4000-8000-000000000011', displayName: 'Later Owner' };
    const client = { query: jest.fn(async (sql: string) => {
      if (sql.includes('INSERT INTO processed_commands')) return { rows: [{ client_command_id: 'command' }] };
      return { rows: [] };
    }) };
    const database = {
      query: jest.fn().mockResolvedValue({ rows: [{ first_synced_at: new Date() }] }),
      transaction: jest.fn(async (work: (value: typeof client) => Promise<unknown>) => work(client)),
    };
    const data = {
      createSyncEvent: jest.fn(), currentCursor: jest.fn().mockResolvedValue(1),
      loadSnapshot: jest.fn().mockResolvedValue({ products: [], productUnits: [], sales: [], saleItems: [], inventoryMovements: [], customers: [], utangEntries: [], expenses: [], staff: [] }),
    };
    const activity = { record: jest.fn() };
    const auth = { verify: jest.fn().mockResolvedValue(actor) };
    const service = new PosService(database as never, data as never, auth as never, activity as never);
    const request = {
      clientCommandId: '00000000-0000-4000-8000-000000000012', baseCursor: 0,
      occurredAt: '2026-10-01T01:00:00.000Z', actorProof: 'signed-token',
      command: { type: 'recordExpense', payload: { category: 'Supplies', description: 'Bags', amount: 500, occurredAt: '2026-10-01T01:00:00.000Z' } },
    } satisfies StoreCommandRequest;

    await service.applyCommand(submitter, request);

    expect(auth.verify).toHaveBeenCalledWith('signed-token');
    expect(activity.record).toHaveBeenCalledWith(client, expect.objectContaining({ actor, submittedBy: submitter, action: 'expense.recorded', clientCommandId: request.clientCommandId }));
  });
});
