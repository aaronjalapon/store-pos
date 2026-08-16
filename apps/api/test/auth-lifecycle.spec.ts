import { ConflictException } from '@nestjs/common';
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
      query: jest.fn().mockResolvedValueOnce({ rows: [{
        user_id: 'owner', display_name: 'Owner', email: 'owner@example.com', staff_code: null,
        password_hash: hashSecret('password'), pin_hash: null, user_active: true, membership_active: true,
        store_active: false, role: 'owner', store_id: 'store', store_name: 'Store',
        store_created_at: new Date(), store_updated_at: new Date(),
      }] }),
    };
    const jwt = { verifyAsync: jest.fn().mockResolvedValue({
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
});
