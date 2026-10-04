import { ConflictException, NotFoundException } from '@nestjs/common';
import { AuthService } from '../src/auth/auth.service';
import { hashSecret } from '../src/auth/crypto';

const config = {
  getOrThrow: jest.fn().mockReturnValue('test-secret'),
  get: jest.fn(),
};

function serviceWith(database: Record<string, unknown>, jwt: Record<string, unknown> = {}) {
  return new AuthService(config as never, jwt as never, database as never);
}

describe('AuthService store lifecycle enforcement', () => {
  it('rejects owner login when the store is suspended', async () => {
    const database = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{
          user_id: 'owner', display_name: 'Owner', email: 'owner@example.com', staff_code: null,
          password_hash: hashSecret('password'), pin_hash: null, user_active: true, membership_active: true,
          store_active: false, role: 'owner', store_id: 'store', store_name: 'Store',
          store_created_at: new Date(), store_updated_at: new Date(),
        }] }),
    };
    const service = serviceWith(database);

    await expect(service.loginOwnerOrAdmin({
      email: 'owner@example.com', password: 'password', deviceId: 'device', deviceName: 'Browser',
    })).rejects.toThrow('This store is suspended');
  });

  it('rejects an existing token after its store is suspended', async () => {
    const database = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [{ credential_version: 1 }] })
        .mockResolvedValueOnce({ rows: [{
        user_id: 'owner', display_name: 'Owner', email: 'owner@example.com', staff_code: null,
        password_hash: hashSecret('password'), pin_hash: null, user_active: true, membership_active: true,
        store_active: false, maintenance_mode: false, credential_version: 1, role: 'owner', store_id: 'store', store_name: 'Store',
        store_created_at: new Date(), store_updated_at: new Date(),
      }] }),
    };
    const jwt = { verifyAsync: jest.fn().mockResolvedValue({
      jti: 'session', credentialVersion: 1,
      sub: 'owner', storeId: 'store', deviceId: 'device', role: 'owner',
      displayName: 'Owner', email: 'owner@example.com', staffCode: null,
    }) };
    const service = serviceWith(database, jwt);

    await expect(service.verify('token')).rejects.toThrow('Your session is no longer active');
  });

  it('protects the last active owner from superadmin suspension', async () => {
    const client = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [{ role: 'owner', is_active: true }] })
        .mockResolvedValueOnce({ rows: [{ count: '0' }] }),
    };
    const database = {
      transaction: jest.fn(async (work: (value: typeof client) => Promise<unknown>) => work(client)),
    };
    const service = serviceWith(database);

    await expect(service.setSuperadminStaffStatus('store', 'owner', false)).rejects.toBeInstanceOf(ConflictException);
    expect(client.query).toHaveBeenCalledTimes(2);
  });

  it('rejects deletion when the store does not exist', async () => {
    const client = { query: jest.fn().mockResolvedValueOnce({ rows: [] }) };
    const database = {
      transaction: jest.fn(async (work: (value: typeof client) => Promise<unknown>) => work(client)),
    };
    const service = serviceWith(database);

    await expect(service.deleteStoreAsSuperadmin('missing-store')).rejects.toBeInstanceOf(NotFoundException);
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  it('requires the store to be inactive before deletion', async () => {
    const client = {
      query: jest.fn().mockResolvedValueOnce({ rows: [{ id: 'store', is_active: true }] }),
    };
    const database = {
      transaction: jest.fn(async (work: (value: typeof client) => Promise<unknown>) => work(client)),
    };
    const service = serviceWith(database);

    await expect(service.deleteStoreAsSuperadmin('store')).rejects.toBeInstanceOf(ConflictException);
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  it('protects inactive stores that contain operational data', async () => {
    const client = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [{ id: 'store', is_active: false }] })
        .mockResolvedValueOnce({ rows: [{ count: '1' }] }),
    };
    const database = {
      transaction: jest.fn(async (work: (value: typeof client) => Promise<unknown>) => work(client)),
    };
    const service = serviceWith(database);

    await expect(service.deleteStoreAsSuperadmin('store')).rejects.toBeInstanceOf(ConflictException);
    expect(client.query).toHaveBeenCalledTimes(2);
  });

  it('deletes an inactive empty store and its orphaned non-superadmin users', async () => {
    const client = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [{ id: 'store', is_active: false }] })
        .mockResolvedValueOnce({ rows: [{ count: '0' }] })
        .mockResolvedValueOnce({ rows: [{ user_id: 'owner' }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] }),
    };
    const database = {
      transaction: jest.fn(async (work: (value: typeof client) => Promise<unknown>) => work(client)),
    };
    const service = serviceWith(database);

    await expect(service.deleteStoreAsSuperadmin('store')).resolves.toEqual({
      deleted: true,
      storeId: 'store',
    });
    expect(client.query).toHaveBeenCalledTimes(5);
    expect(client.query.mock.calls[3]?.[0]).toBe('DELETE FROM stores WHERE id = $1');
    expect(client.query.mock.calls[4]?.[0]).toContain('DELETE FROM users');
  });
});

describe('AuthService manager action approval', () => {
  const owner = {
    userId: 'owner', storeId: 'store', deviceId: 'device', role: 'owner' as const,
    displayName: 'Owner', email: 'owner@example.com', staffCode: null,
  };
  const approval = {
    action: 'adjust_stock' as const,
    clientCommandId: '00000000-0000-4000-8000-000000000071',
    password: 'correct-password',
  };

  it('issues a short-lived command-bound proof after verifying the manager password', async () => {
    const database = { query: jest.fn().mockResolvedValue({ rows: [{ password_hash: hashSecret(approval.password) }] }) };
    const jwt = { signAsync: jest.fn().mockResolvedValue('manager-proof') };
    const service = serviceWith(database, jwt);

    await expect(service.confirmManagerAction(owner, approval)).resolves.toEqual({ proof: 'manager-proof' });
    expect(jwt.signAsync).toHaveBeenCalledWith(expect.objectContaining({
      sub: owner.userId,
      storeId: owner.storeId,
      deviceId: owner.deviceId,
      action: 'adjust_stock',
      clientCommandId: approval.clientCommandId,
    }), expect.objectContaining({ audience: 'gma-manager-action', expiresIn: '2m' }));
    expect(JSON.stringify(jwt.signAsync.mock.calls)).not.toContain(approval.password);
  });

  it('rejects an incorrect manager password', async () => {
    const database = { query: jest.fn().mockResolvedValue({ rows: [{ password_hash: hashSecret('different-password') }] }) };
    const service = serviceWith(database, { signAsync: jest.fn() });

    await expect(service.confirmManagerAction(owner, approval)).rejects.toThrow('Password is incorrect');
  });

  it('rejects cashier approval before checking credentials', async () => {
    const database = { query: jest.fn() };
    const service = serviceWith(database, { signAsync: jest.fn() });

    await expect(service.confirmManagerAction({ ...owner, role: 'cashier' }, approval)).rejects.toThrow('Only an owner or admin');
    expect(database.query).not.toHaveBeenCalled();
  });

  it('rejects an approval proof bound to another command', async () => {
    const jwt = { verifyAsync: jest.fn().mockResolvedValue({
      sub: owner.userId,
      storeId: owner.storeId,
      deviceId: owner.deviceId,
      action: 'adjust_stock',
      clientCommandId: '00000000-0000-4000-8000-000000000099',
    }) };
    const service = serviceWith({}, jwt);

    await expect(service.verifyManagerActionProof(owner, 'proof', 'adjust_stock', approval.clientCommandId))
      .rejects.toThrow('expired or does not match');
  });
});
