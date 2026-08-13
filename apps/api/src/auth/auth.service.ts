import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type {
  AuthSession,
  CashierLoginRequest,
  DeviceInfo,
  OwnerLoginRequest,
  Role,
  SessionUser,
  SetupOwnerRequest,
  StaffMember,
  StoreRole,
  StoreInfo,
  SuperadminCreateStoreRequest,
  SuperadminStaffInput,
  SuperadminStoreSummary,
} from '@gma/contracts';
import { DatabaseService } from '../database/database.service';
import { hashSecret, verifySecret } from './crypto';
import type { SessionPrincipal } from './auth.types';

interface MembershipRow {
  user_id: string;
  display_name: string;
  email: string | null;
  staff_code: string | null;
  password_hash: string | null;
  pin_hash: string | null;
  user_active: boolean;
  membership_active: boolean;
  role: StoreRole;
  store_id: string;
  store_name: string;
  store_created_at: Date;
  store_updated_at: Date;
}

interface DeviceRow {
  id: string;
  store_id: string;
  name: string;
  first_synced_at: Date | null;
  last_seen_at: Date;
  created_at: Date;
  updated_at: Date;
}

interface SuperadminUserRow {
  id: string;
  display_name: string;
  email: string;
  password_hash: string | null;
  is_active: boolean;
  is_superadmin: boolean;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly config: ConfigService,
    private readonly jwt: JwtService,
    private readonly database: DatabaseService,
  ) {}

  async getSetupStatus() {
    const result = await this.database.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM users');
    return { needsSetup: Number(result.rows[0]?.count ?? 0) === 0 };
  }

  async ensureConfiguredSuperadmin() {
    const email = this.config.get<string>('SUPERADMIN_EMAIL')?.trim().toLowerCase();
    const password = this.config.get<string>('SUPERADMIN_PASSWORD');
    const displayName = this.config.get<string>('SUPERADMIN_DISPLAY_NAME')?.trim() || 'Super Admin';
    if (!email || !password) return;

    await this.database.query(
      `INSERT INTO users (id, display_name, email, password_hash, is_active, is_superadmin, created_at, updated_at)
       VALUES ($1, $2, $3, $4, true, true, now(), now())
       ON CONFLICT (email) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         password_hash = EXCLUDED.password_hash,
         is_active = true,
         is_superadmin = true,
         updated_at = now()`,
      [crypto.randomUUID(), displayName, email, hashSecret(password)],
    );
  }

  async setupOwner(input: SetupOwnerRequest) {
    const existing = await this.getSetupStatus();
    if (!existing.needsSetup) throw new ConflictException('The store has already been initialized');
    const principal = await this.database.transaction(async (client): Promise<SessionPrincipal & { role: StoreRole }> => {
      const now = new Date();
      const storeId = crypto.randomUUID();
      const userId = crypto.randomUUID();
      await client.query(
        `INSERT INTO stores (id, name, created_at, updated_at)
         VALUES ($1, $2, $3, $3)`,
        [storeId, input.storeName.trim(), now],
      );
      await client.query(
        `INSERT INTO users (id, display_name, email, password_hash, is_active, created_at, updated_at)
         VALUES ($1, $2, $3, $4, true, $5, $5)`,
        [userId, input.displayName.trim(), input.email.toLowerCase(), hashSecret(input.password), now],
      );
      await client.query(
        `INSERT INTO store_memberships (store_id, user_id, role, is_active, created_at, updated_at)
         VALUES ($1, $2, 'owner', true, $3, $3)`,
        [storeId, userId, now],
      );
      await this.upsertDevice(client, {
        deviceId: input.deviceId,
        storeId,
        deviceName: input.deviceName.trim(),
        registeredByUserId: userId,
      });
      return {
        userId,
        storeId,
        role: 'owner',
        deviceId: input.deviceId,
        displayName: input.displayName.trim(),
        email: input.email.toLowerCase(),
        staffCode: null,
      };
    });
    return this.issueSession(principal);
  }

  async loginOwnerOrAdmin(input: OwnerLoginRequest) {
    const superadmin = await this.findSuperadminByEmail(input.email.toLowerCase());
    if (superadmin) {
      if (!verifySecret(input.password, superadmin.password_hash)) {
        throw new UnauthorizedException('Invalid email or password');
      }
      if (!superadmin.is_active) throw new UnauthorizedException('Your account is inactive');
      return this.issueSuperadminSession(superadmin);
    }

    const membership = await this.findMembershipByEmail(input.email.toLowerCase());
    if (!membership || !verifySecret(input.password, membership.password_hash)) {
      throw new UnauthorizedException('Invalid email or password');
    }
    if (!membership.user_active || !membership.membership_active) throw new UnauthorizedException('Your account is inactive');
    await this.database.transaction(async (client) => {
      await this.upsertDevice(client, {
        deviceId: input.deviceId,
        storeId: membership.store_id,
        deviceName: input.deviceName.trim(),
        registeredByUserId: membership.user_id,
      });
    });
    return this.issueSession({
      userId: membership.user_id,
      storeId: membership.store_id,
      role: membership.role,
      deviceId: input.deviceId,
      displayName: membership.display_name,
      email: membership.email,
      staffCode: membership.staff_code,
    });
  }

  async loginCashier(input: CashierLoginRequest) {
    const membership = await this.findMembershipByStaffCode(input.storeId, input.staffCode.trim());
    if (!membership || membership.role !== 'cashier' || !verifySecret(input.pin, membership.pin_hash)) {
      throw new UnauthorizedException('Invalid cashier code or PIN');
    }
    if (!membership.user_active || !membership.membership_active) throw new UnauthorizedException('This cashier account is inactive');
    await this.database.transaction(async (client) => {
      await this.upsertDevice(client, {
        deviceId: input.deviceId,
        storeId: membership.store_id,
        deviceName: input.deviceName.trim(),
        registeredByUserId: membership.user_id,
      });
    });
    return this.issueSession({
      userId: membership.user_id,
      storeId: membership.store_id,
      role: membership.role,
      deviceId: input.deviceId,
      displayName: membership.display_name,
      email: membership.email,
      staffCode: membership.staff_code,
    });
  }

  async verify(token: string): Promise<SessionPrincipal> {
    try {
      const payload = await this.jwt.verifyAsync<{
        sub: string;
        storeId: string | null;
        deviceId: string | null;
        role: Role;
        displayName: string;
        email: string | null;
        staffCode: string | null;
      }>(token, {
        secret: this.config.getOrThrow<string>('JWT_SECRET'),
        issuer: 'gma-pos-api',
      });
      if (payload.role === 'superadmin') {
        const superadmin = await this.findSuperadminById(payload.sub);
        if (!superadmin?.is_active) throw new UnauthorizedException('Your session is no longer active');
        return {
          userId: superadmin.id,
          storeId: '',
          deviceId: '',
          role: 'superadmin',
          displayName: superadmin.display_name,
          email: superadmin.email,
          staffCode: null,
        };
      }
      if (!payload.storeId || !payload.deviceId) {
        throw new UnauthorizedException('Invalid or expired session token');
      }
      const membership = await this.findMembershipById(payload.sub, payload.storeId);
      if (!membership || !membership.user_active || !membership.membership_active) {
        throw new UnauthorizedException('Your session is no longer active');
      }
      const device = await this.database.query<DeviceRow>(
        'SELECT * FROM devices WHERE id = $1 AND store_id = $2',
        [payload.deviceId, payload.storeId],
      );
      if (!device.rows[0]) throw new UnauthorizedException('This device is not registered for the store');
      return {
        userId: payload.sub,
        storeId: payload.storeId,
        deviceId: payload.deviceId,
        role: membership.role,
        displayName: membership.display_name,
        email: membership.email,
        staffCode: membership.staff_code,
      };
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error;
      throw new UnauthorizedException('Invalid or expired session token');
    }
  }

  async buildSession(principal: SessionPrincipal, token: string): Promise<AuthSession> {
    if (principal.role === 'superadmin') {
      if (!principal.email) throw new NotFoundException('Session context could not be loaded');
      return {
        token,
        store: null,
        device: null,
        user: {
          id: principal.userId,
          displayName: principal.displayName,
          email: principal.email,
          staffCode: null,
          role: 'superadmin',
        },
      };
    }

    const storeRole: StoreRole = principal.role;
    const [store, device] = await Promise.all([
      this.database.query<{
        id: string;
        name: string;
        created_at: Date;
        updated_at: Date;
      }>('SELECT id, name, created_at, updated_at FROM stores WHERE id = $1', [principal.storeId]),
      this.database.query<DeviceRow>('SELECT * FROM devices WHERE id = $1 AND store_id = $2', [principal.deviceId, principal.storeId]),
    ]);
    if (!store.rows[0] || !device.rows[0]) throw new NotFoundException('Session context could not be loaded');
    return {
      token,
      store: this.mapStore(store.rows[0]),
      device: this.mapDevice(device.rows[0]),
      user: {
        id: principal.userId,
        displayName: principal.displayName,
        email: principal.email,
        staffCode: principal.staffCode,
        role: storeRole,
      },
    };
  }

  async listSuperadminStores(): Promise<SuperadminStoreSummary[]> {
    const result = await this.database.query<{
      id: string;
      name: string;
      owner_count: string;
      admin_count: string;
      cashier_count: string;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT stores.id, stores.name, stores.created_at, stores.updated_at,
              COUNT(*) FILTER (WHERE store_memberships.role = 'owner' AND store_memberships.is_active) AS owner_count,
              COUNT(*) FILTER (WHERE store_memberships.role = 'admin' AND store_memberships.is_active) AS admin_count,
              COUNT(*) FILTER (WHERE store_memberships.role = 'cashier' AND store_memberships.is_active) AS cashier_count
         FROM stores
         LEFT JOIN store_memberships ON store_memberships.store_id = stores.id
        GROUP BY stores.id
        ORDER BY stores.created_at DESC`,
    );
    return result.rows.map((row) => this.mapSuperadminStore(row));
  }

  async createStoreAsSuperadmin(input: SuperadminCreateStoreRequest) {
    const result = await this.database.transaction(async (client) => {
      const now = new Date();
      const storeId = crypto.randomUUID();
      const userId = crypto.randomUUID();
      await client.query(
        `INSERT INTO stores (id, name, created_at, updated_at)
         VALUES ($1, $2, $3, $3)`,
        [storeId, input.storeName.trim(), now],
      );
      await client.query(
        `INSERT INTO users (id, display_name, email, password_hash, is_active, created_at, updated_at)
         VALUES ($1, $2, $3, $4, true, $5, $5)`,
        [userId, input.ownerDisplayName.trim(), input.ownerEmail.toLowerCase(), hashSecret(input.ownerPassword), now],
      );
      await client.query(
        `INSERT INTO store_memberships (store_id, user_id, role, is_active, created_at, updated_at)
         VALUES ($1, $2, 'owner', true, $3, $3)`,
        [storeId, userId, now],
      );
      await client.query('INSERT INTO sync_events (store_id, kind) VALUES ($1, $2)', [storeId, 'staff']);
      return { storeId, userId };
    });
    return {
      store: await this.getSuperadminStore(result.storeId),
      staff: await this.getStaffMember(result.storeId, result.userId),
    };
  }

  async createStoreStaffAsSuperadmin(storeId: string, input: SuperadminStaffInput) {
    const userId = await this.database.transaction(async (client) => {
      const userId = crypto.randomUUID();
      const now = new Date();
      await client.query(
        `INSERT INTO users (id, display_name, email, password_hash, is_active, created_at, updated_at)
         VALUES ($1, $2, $3, $4, true, $5, $5)`,
        [userId, input.displayName.trim(), input.email.toLowerCase(), hashSecret(input.password), now],
      );
      await client.query(
        `INSERT INTO store_memberships (store_id, user_id, role, is_active, created_at, updated_at)
         VALUES ($1, $2, $3, true, $4, $4)`,
        [storeId, userId, input.role, now],
      );
      await client.query('UPDATE stores SET updated_at = now() WHERE id = $1', [storeId]);
      await client.query('INSERT INTO sync_events (store_id, kind) VALUES ($1, $2)', [storeId, 'staff']);
      return userId;
    });
    return {
      store: await this.getSuperadminStore(storeId),
      staff: await this.getStaffMember(storeId, userId),
    };
  }

  async createStaff(storeId: string, actor: SessionPrincipal, input: {
    role: 'admin' | 'cashier';
    displayName: string;
    email?: string;
    password?: string;
    staffCode?: string;
    pin?: string;
  }): Promise<StaffMember> {
    const userId = await this.database.transaction(async (client) => {
      const userId = crypto.randomUUID();
      const now = new Date();
      await client.query(
        `INSERT INTO users (id, display_name, email, password_hash, staff_code, pin_hash, is_active, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, true, $7, $7)`,
        [
          userId,
          input.displayName.trim(),
          input.email?.toLowerCase() ?? null,
          input.password ? hashSecret(input.password) : null,
          input.staffCode?.trim() ?? null,
          input.pin ? hashSecret(input.pin) : null,
          now,
        ],
      );
      await client.query(
        `INSERT INTO store_memberships (store_id, user_id, role, is_active, created_at, updated_at)
         VALUES ($1, $2, $3, true, $4, $4)`,
        [storeId, userId, input.role, now],
      );
      await this.touchStore(client, storeId, actor.userId);
      return userId;
    });
    return this.getStaffMember(storeId, userId);
  }

  async listStaff(storeId: string) {
    const result = await this.database.query<{
      id: string;
      display_name: string;
      email: string | null;
      staff_code: string | null;
      role: Role;
      is_active: boolean;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT users.id, users.display_name, users.email, users.staff_code,
              store_memberships.role, (users.is_active AND store_memberships.is_active) AS is_active,
              users.created_at, users.updated_at
         FROM users
         JOIN store_memberships ON store_memberships.user_id = users.id
        WHERE store_memberships.store_id = $1
        ORDER BY CASE store_memberships.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, users.display_name ASC`,
      [storeId],
    );
    return result.rows.map((row) => this.mapStaff(row));
  }

  async disableStaff(storeId: string, actor: SessionPrincipal, userId: string) {
    if (actor.userId === userId) throw new ConflictException('You cannot disable your own account');
    await this.database.transaction(async (client) => {
      const membership = await client.query<{ role: Role }>(
        'SELECT role FROM store_memberships WHERE store_id = $1 AND user_id = $2',
        [storeId, userId],
      );
      if (!membership.rows[0]) throw new NotFoundException('Staff account not found');
      if (membership.rows[0].role === 'owner') throw new ConflictException('Owner access cannot be disabled here');
      await client.query('UPDATE store_memberships SET is_active = false, updated_at = now() WHERE store_id = $1 AND user_id = $2', [storeId, userId]);
      await client.query('UPDATE users SET is_active = false, updated_at = now() WHERE id = $1', [userId]);
      await this.touchStore(client, storeId, actor.userId);
    });
    return this.getStaffMember(storeId, userId);
  }

  async resetStaffSecret(storeId: string, actor: SessionPrincipal, userId: string, input: { password?: string; pin?: string }) {
    await this.database.transaction(async (client) => {
      const membership = await client.query<{ role: Role }>(
        'SELECT role FROM store_memberships WHERE store_id = $1 AND user_id = $2',
        [storeId, userId],
      );
      if (!membership.rows[0]) throw new NotFoundException('Staff account not found');
      const role = membership.rows[0].role;
      if (role === 'cashier') {
        if (!input.pin) throw new ConflictException('Cashiers require a new PIN');
        await client.query('UPDATE users SET pin_hash = $1, updated_at = now() WHERE id = $2', [hashSecret(input.pin), userId]);
      } else {
        if (!input.password) throw new ConflictException('Admins require a new password');
        await client.query('UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2', [hashSecret(input.password), userId]);
      }
      await this.touchStore(client, storeId, actor.userId);
    });
    return this.getStaffMember(storeId, userId);
  }

  async touchDevice(storeId: string, deviceId: string) {
    await this.database.query(
      'UPDATE devices SET last_seen_at = now(), updated_at = now() WHERE id = $1 AND store_id = $2',
      [deviceId, storeId],
    );
  }

  async markDeviceSynced(storeId: string, deviceId: string) {
    await this.database.query(
      `UPDATE devices
          SET first_synced_at = COALESCE(first_synced_at, now()),
              last_seen_at = now(),
              updated_at = now()
        WHERE id = $1 AND store_id = $2`,
      [deviceId, storeId],
    );
  }

  private async issueSession(principal: SessionPrincipal & { role: StoreRole }): Promise<AuthSession> {
    const token = await this.jwt.signAsync(
      {
        sub: principal.userId,
        storeId: principal.storeId,
        deviceId: principal.deviceId,
        role: principal.role,
        displayName: principal.displayName,
        email: principal.email,
        staffCode: principal.staffCode,
      },
      {
        secret: this.config.getOrThrow<string>('JWT_SECRET'),
        issuer: 'gma-pos-api',
        expiresIn: '14d',
      },
    );
    return this.buildSession(principal, token);
  }

  private async issueSuperadminSession(user: SuperadminUserRow): Promise<AuthSession> {
    const token = await this.jwt.signAsync(
      {
        sub: user.id,
        storeId: null,
        deviceId: null,
        role: 'superadmin',
        displayName: user.display_name,
        email: user.email,
        staffCode: null,
      },
      {
        secret: this.config.getOrThrow<string>('JWT_SECRET'),
        issuer: 'gma-pos-api',
        expiresIn: '14d',
      },
    );
    return {
      token,
      store: null,
      device: null,
      user: {
        id: user.id,
        displayName: user.display_name,
        email: user.email,
        staffCode: null,
        role: 'superadmin',
      },
    };
  }

  private async findSuperadminByEmail(email: string) {
    const result = await this.database.query<SuperadminUserRow>(
      `SELECT id, display_name, email, password_hash, is_active, is_superadmin
         FROM users
        WHERE LOWER(email) = LOWER($1) AND is_superadmin = true
        LIMIT 1`,
      [email],
    );
    return result.rows[0] ?? null;
  }

  private async findSuperadminById(userId: string) {
    const result = await this.database.query<SuperadminUserRow>(
      `SELECT id, display_name, email, password_hash, is_active, is_superadmin
         FROM users
        WHERE id = $1 AND is_superadmin = true
        LIMIT 1`,
      [userId],
    );
    return result.rows[0] ?? null;
  }

  private async findMembershipByEmail(email: string) {
    const result = await this.database.query<MembershipRow>(
      `SELECT users.id AS user_id, users.display_name, users.email, users.staff_code,
              users.password_hash, users.pin_hash, users.is_active AS user_active,
              store_memberships.is_active AS membership_active, store_memberships.role,
              stores.id AS store_id, stores.name AS store_name, stores.created_at AS store_created_at, stores.updated_at AS store_updated_at
         FROM users
         JOIN store_memberships ON store_memberships.user_id = users.id
         JOIN stores ON stores.id = store_memberships.store_id
        WHERE LOWER(users.email) = LOWER($1)
        ORDER BY CASE store_memberships.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, store_memberships.created_at ASC
        LIMIT 1`,
      [email],
    );
    return result.rows[0] ?? null;
  }

  private async findMembershipByStaffCode(storeId: string, staffCode: string) {
    const result = await this.database.query<MembershipRow>(
      `SELECT users.id AS user_id, users.display_name, users.email, users.staff_code,
              users.password_hash, users.pin_hash, users.is_active AS user_active,
              store_memberships.is_active AS membership_active, store_memberships.role,
              stores.id AS store_id, stores.name AS store_name, stores.created_at AS store_created_at, stores.updated_at AS store_updated_at
         FROM users
         JOIN store_memberships ON store_memberships.user_id = users.id
         JOIN stores ON stores.id = store_memberships.store_id
        WHERE store_memberships.store_id = $1 AND users.staff_code = $2
        LIMIT 1`,
      [storeId, staffCode],
    );
    return result.rows[0] ?? null;
  }

  private async findMembershipById(userId: string, storeId: string) {
    const result = await this.database.query<MembershipRow>(
      `SELECT users.id AS user_id, users.display_name, users.email, users.staff_code,
              users.password_hash, users.pin_hash, users.is_active AS user_active,
              store_memberships.is_active AS membership_active, store_memberships.role,
              stores.id AS store_id, stores.name AS store_name, stores.created_at AS store_created_at, stores.updated_at AS store_updated_at
         FROM users
         JOIN store_memberships ON store_memberships.user_id = users.id
         JOIN stores ON stores.id = store_memberships.store_id
        WHERE users.id = $1 AND store_memberships.store_id = $2
        LIMIT 1`,
      [userId, storeId],
    );
    return result.rows[0] ?? null;
  }

  private async upsertDevice(client: { query: DatabaseService['query'] }, input: {
    deviceId: string;
    storeId: string;
    deviceName: string;
    registeredByUserId: string;
  }) {
    const result = await client.query<{ id: string }>(
      `INSERT INTO devices (id, store_id, name, registered_by_user_id, created_at, updated_at, last_seen_at)
       VALUES ($1, $2, $3, $4, now(), now(), now())
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         registered_by_user_id = COALESCE(devices.registered_by_user_id, EXCLUDED.registered_by_user_id),
         last_seen_at = now(),
         updated_at = now()
       WHERE devices.store_id = EXCLUDED.store_id
       RETURNING id`,
      [input.deviceId, input.storeId, input.deviceName, input.registeredByUserId],
    );
    if (result.rowCount !== 1) throw new ConflictException('This device is already linked to another store');
  }

  private async getStaffMember(storeId: string, userId: string) {
    const result = await this.database.query<{
      id: string;
      display_name: string;
      email: string | null;
      staff_code: string | null;
      role: Role;
      is_active: boolean;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT users.id, users.display_name, users.email, users.staff_code,
              store_memberships.role, (users.is_active AND store_memberships.is_active) AS is_active,
              users.created_at, users.updated_at
         FROM users
         JOIN store_memberships ON store_memberships.user_id = users.id
        WHERE store_memberships.store_id = $1 AND users.id = $2`,
      [storeId, userId],
    );
    if (!result.rows[0]) throw new NotFoundException('Staff account not found');
    return this.mapStaff(result.rows[0]);
  }

  private async getSuperadminStore(storeId: string): Promise<SuperadminStoreSummary> {
    const result = await this.database.query<{
      id: string;
      name: string;
      owner_count: string;
      admin_count: string;
      cashier_count: string;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT stores.id, stores.name, stores.created_at, stores.updated_at,
              COUNT(*) FILTER (WHERE store_memberships.role = 'owner' AND store_memberships.is_active) AS owner_count,
              COUNT(*) FILTER (WHERE store_memberships.role = 'admin' AND store_memberships.is_active) AS admin_count,
              COUNT(*) FILTER (WHERE store_memberships.role = 'cashier' AND store_memberships.is_active) AS cashier_count
         FROM stores
         LEFT JOIN store_memberships ON store_memberships.store_id = stores.id
        WHERE stores.id = $1
        GROUP BY stores.id
        LIMIT 1`,
      [storeId],
    );
    if (!result.rows[0]) throw new NotFoundException('Store not found');
    return this.mapSuperadminStore(result.rows[0]);
  }

  private async touchStore(client: { query: DatabaseService['query'] }, storeId: string, _userId: string) {
    await client.query('UPDATE stores SET updated_at = now() WHERE id = $1', [storeId]);
    await client.query('INSERT INTO sync_events (store_id, kind) VALUES ($1, $2)', [storeId, 'staff']);
  }

  private mapStore(row: { id: string; name: string; created_at: Date; updated_at: Date }): StoreInfo {
    return {
      id: row.id,
      name: row.name,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  }

  private mapSuperadminStore(row: {
    id: string;
    name: string;
    owner_count: string;
    admin_count: string;
    cashier_count: string;
    created_at: Date;
    updated_at: Date;
  }): SuperadminStoreSummary {
    return {
      id: row.id,
      name: row.name,
      ownerCount: Number(row.owner_count),
      adminCount: Number(row.admin_count),
      cashierCount: Number(row.cashier_count),
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  }

  private mapDevice(row: DeviceRow): DeviceInfo {
    return {
      id: row.id,
      storeId: row.store_id,
      name: row.name,
      firstSyncedAt: row.first_synced_at?.toISOString() ?? null,
      lastSeenAt: row.last_seen_at.toISOString(),
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  }

  private mapStaff(row: {
    id: string;
    display_name: string;
    email: string | null;
    staff_code: string | null;
    role: Role;
    is_active: boolean;
    created_at: Date;
    updated_at: Date;
  }): StaffMember {
    return {
      id: row.id,
      displayName: row.display_name,
      email: row.email,
      staffCode: row.staff_code,
      role: row.role,
      isActive: row.is_active,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  }
}
