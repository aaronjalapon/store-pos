import {
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { isManagerRole } from '@gma/contracts';
import type {
  AuthSession,
  CashierLoginRequest,
  DeviceInfo,
  DeviceEnrollmentDecisionResponse,
  ManagerActionConfirmationRequest,
  ManagerActionConfirmationResponse,
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
import { ActivityService } from '../activity/activity.service';

interface MembershipRow {
  user_id: string;
  display_name: string;
  email: string | null;
  staff_code: string | null;
  password_hash: string | null;
  pin_hash: string | null;
  user_active: boolean;
  membership_active: boolean;
  store_active: boolean;
  maintenance_mode: boolean;
  role: StoreRole;
  store_id: string;
  store_name: string;
  store_created_at: Date;
  store_updated_at: Date;
  credential_version: number;
}

interface DeviceRow {
  id: string;
  store_id: string;
  name: string;
  first_synced_at: Date | null;
  last_seen_at: Date;
  created_at: Date;
  updated_at: Date;
  is_enrolled: boolean;
  revoked_at: Date | null;
}

interface SuperadminUserRow {
  id: string;
  display_name: string;
  email: string;
  password_hash: string | null;
  is_active: boolean;
  is_superadmin: boolean;
  credential_version: number;
}

interface IssuedSession {
  session: AuthSession;
  refreshToken: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly config: ConfigService,
    private readonly jwt: JwtService,
    private readonly database: DatabaseService,
    @Optional() private readonly activity?: ActivityService,
  ) {}

  async getSetupStatus() {
    const result = await this.database.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM stores');
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
    const principal = await this.database.transaction(async (client): Promise<SessionPrincipal & { role: StoreRole }> => {
      await client.query('SELECT pg_advisory_xact_lock($1)', [4_202_610_03]);
      const existing = await client.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM stores');
      if (Number(existing.rows[0]?.count ?? 0) > 0) throw new ConflictException('The store has already been initialized');
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
      const principal = {
        userId,
        storeId,
        role: 'owner',
        deviceId: input.deviceId,
        displayName: input.displayName.trim(),
        email: input.email.toLowerCase(),
        staffCode: null,
      } satisfies SessionPrincipal;
      await this.activity?.record(client, {
        storeId,
        actor: principal,
        category: 'auth',
        action: 'auth.signed_in',
        entityType: 'user',
        entityId: userId,
        summary: `${principal.displayName} signed in as owner`,
        details: { method: 'initial_setup' },
      });
      return principal;
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
    if (!membership.store_active) throw new UnauthorizedException('This store is suspended');
    if (!membership.user_active || !membership.membership_active) throw new UnauthorizedException('Your account is inactive');
    const principal: SessionPrincipal & { role: StoreRole } = {
      userId: membership.user_id,
      storeId: membership.store_id,
      role: membership.role,
      deviceId: input.deviceId,
      displayName: membership.display_name,
      email: membership.email,
      staffCode: membership.staff_code,
    };
    await this.requireEnrolledDevice(membership, input.deviceId, input.deviceName.trim());
    await this.database.transaction(async (client) => {
      await this.activity?.record(client, {
        storeId: membership.store_id,
        actor: principal,
        category: 'auth',
        action: 'auth.signed_in',
        entityType: 'user',
        entityId: membership.user_id,
        summary: `${membership.display_name} signed in as ${membership.role}`,
        details: { method: 'password' },
      });
    });
    return this.issueSession(principal);
  }

  async loginCashier(input: CashierLoginRequest) {
    const membership = await this.findMembershipByStaffCode(input.storeId, input.staffCode.trim());
    if (!membership || membership.role !== 'cashier' || !verifySecret(input.pin, membership.pin_hash)) {
      throw new UnauthorizedException('Invalid cashier code or PIN');
    }
    if (!membership.store_active) throw new UnauthorizedException('This store is suspended');
    if (!membership.user_active || !membership.membership_active) throw new UnauthorizedException('This cashier account is inactive');
    const principal: SessionPrincipal & { role: 'cashier' } = {
      userId: membership.user_id,
      storeId: membership.store_id,
      role: 'cashier',
      deviceId: input.deviceId,
      displayName: membership.display_name,
      email: membership.email,
      staffCode: membership.staff_code,
    };
    await this.requireEnrolledDevice(membership, input.deviceId, input.deviceName.trim());
    await this.database.transaction(async (client) => {
      await this.activity?.record(client, {
        storeId: membership.store_id,
        actor: principal,
        category: 'auth',
        action: 'auth.signed_in',
        entityType: 'user',
        entityId: membership.user_id,
        summary: `${membership.display_name} signed in as cashier`,
        details: { method: 'pin' },
      });
    });
    return this.issueSession(principal);
  }

  async verify(token: string): Promise<SessionPrincipal> {
    try {
      const payload = await this.jwt.verifyAsync<{
        jti: string;
        sub: string;
        storeId: string | null;
        deviceId: string | null;
        role: Role;
        displayName: string;
        email: string | null;
        staffCode: string | null;
        credentialVersion: number;
      }>(token, {
        secret: this.config.getOrThrow<string>('JWT_SECRET'),
        issuer: 'gma-pos-api',
      });
      if (!payload.jti || !payload.credentialVersion) throw new UnauthorizedException('Invalid or expired session token');
      const activeSession = await this.database.query<{ credential_version: number }>(
        `SELECT credential_version
           FROM auth_sessions
          WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL AND refresh_expires_at > now()`,
        [payload.jti, payload.sub],
      );
      if (!activeSession.rows[0] || activeSession.rows[0].credential_version !== payload.credentialVersion) {
        throw new UnauthorizedException('Your session is no longer active');
      }
      if (payload.role === 'superadmin') {
        const superadmin = await this.findSuperadminById(payload.sub);
        if (!superadmin?.is_active || superadmin.credential_version !== payload.credentialVersion) throw new UnauthorizedException('Your session is no longer active');
        return {
          sessionId: payload.jti,
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
      if (!membership || !membership.store_active || membership.maintenance_mode || !membership.user_active || !membership.membership_active
        || membership.credential_version !== payload.credentialVersion) {
        throw new UnauthorizedException('Your session is no longer active');
      }
      const device = await this.database.query<DeviceRow>(
        'SELECT * FROM devices WHERE id = $1 AND store_id = $2 AND is_enrolled = true AND revoked_at IS NULL',
        [payload.deviceId, payload.storeId],
      );
      if (!device.rows[0]) throw new UnauthorizedException('This device is not registered for the store');
      return {
        sessionId: payload.jti,
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

  async logout(principal: SessionPrincipal) {
    if (principal.sessionId) {
      await this.database.query(
        `UPDATE auth_sessions
            SET revoked_at = COALESCE(revoked_at, now()), revoke_reason = COALESCE(revoke_reason, 'logout')
          WHERE id = $1`,
        [principal.sessionId],
      );
    }
    if (principal.storeId && principal.role !== 'superadmin') {
      await this.activity?.recordNow({
        storeId: principal.storeId,
        actor: principal,
        category: 'auth',
        action: 'auth.signed_out',
        entityType: 'user',
        entityId: principal.userId,
        summary: `${principal.displayName} signed out`,
      });
    }
    return { loggedOut: true as const };
  }

  async refresh(refreshToken: string): Promise<IssuedSession> {
    const tokenHash = this.hashRefreshToken(refreshToken);
    const result = await this.database.query<{
      id: string;
      user_id: string;
      store_id: string | null;
      device_id: string | null;
      credential_version: number;
      refresh_expires_at: Date;
    }>(
      `SELECT id, user_id, store_id, device_id, credential_version, refresh_expires_at
         FROM auth_sessions
        WHERE refresh_token_hash = $1 AND revoked_at IS NULL AND refresh_expires_at > now()
        FOR UPDATE`,
      [tokenHash],
    );
    const current = result.rows[0];
    if (!current) throw new UnauthorizedException('Refresh session is invalid or expired');

    let principal: SessionPrincipal & { role: Role };
    if (!current.store_id) {
      const user = await this.findSuperadminById(current.user_id);
      if (!user?.is_active || user.credential_version !== current.credential_version) throw new UnauthorizedException('Your session is no longer active');
      principal = { sessionId: current.id, userId: user.id, storeId: '', deviceId: '', role: 'superadmin', displayName: user.display_name, email: user.email, staffCode: null };
    } else {
      const membership = await this.findMembershipById(current.user_id, current.store_id);
      if (!membership || !membership.user_active || !membership.membership_active || !membership.store_active || membership.maintenance_mode
        || membership.credential_version !== current.credential_version || !current.device_id) {
        throw new UnauthorizedException('Your session is no longer active');
      }
      const device = await this.database.query<DeviceRow>(
        'SELECT * FROM devices WHERE id = $1 AND store_id = $2 AND is_enrolled = true AND revoked_at IS NULL',
        [current.device_id, current.store_id],
      );
      if (!device.rows[0]) throw new UnauthorizedException('This device is no longer active');
      principal = {
        sessionId: current.id, userId: membership.user_id, storeId: membership.store_id, deviceId: current.device_id,
        role: membership.role, displayName: membership.display_name, email: membership.email, staffCode: membership.staff_code,
      };
    }

    const nextRefreshToken = randomBytes(32).toString('base64url');
    const rotated = await this.database.query(
      `UPDATE auth_sessions
          SET refresh_token_hash = $2, last_seen_at = now()
        WHERE id = $1 AND refresh_token_hash = $3 AND revoked_at IS NULL
        RETURNING id`,
      [current.id, this.hashRefreshToken(nextRefreshToken), tokenHash],
    );
    if (!rotated.rows[0]) throw new UnauthorizedException('Refresh session was already rotated');
    const accessToken = await this.signAccessToken(principal, current.id, current.credential_version);
    return { session: await this.buildSession(principal, accessToken), refreshToken: nextRefreshToken };
  }

  async listPendingDeviceEnrollments(principal: SessionPrincipal) {
    if (principal.role !== 'superadmin' && !isManagerRole(principal.role)) {
      throw new ForbiddenException('Only an owner, admin, or superadmin can manage devices');
    }
    const values: unknown[] = [];
    const scope = principal.role === 'superadmin' ? '' : 'AND challenges.store_id = $1';
    if (principal.role !== 'superadmin') values.push(principal.storeId);
    const result = await this.database.query<{
      id: string;
      store_id: string;
      store_name: string;
      user_id: string;
      display_name: string;
      device_id: string;
      device_name: string;
      expires_at: Date;
      created_at: Date;
    }>(
      `SELECT challenges.id, challenges.store_id, stores.name AS store_name, challenges.user_id,
              users.display_name, challenges.device_id, challenges.device_name,
              challenges.expires_at, challenges.created_at
         FROM device_enrollment_challenges challenges
         JOIN stores ON stores.id = challenges.store_id
         JOIN users ON users.id = challenges.user_id
        WHERE challenges.approved_at IS NULL AND challenges.denied_at IS NULL
          AND challenges.expires_at > now() ${scope}
        ORDER BY challenges.created_at ASC`,
      values,
    );
    return {
      challenges: result.rows.map((row) => ({
        id: row.id,
        storeId: row.store_id,
        storeName: row.store_name,
        userId: row.user_id,
        displayName: row.display_name,
        deviceId: row.device_id,
        deviceName: row.device_name,
        expiresAt: row.expires_at.toISOString(),
        createdAt: row.created_at.toISOString(),
      })),
    };
  }

  async decideDeviceEnrollment(
    principal: SessionPrincipal,
    challengeId: string,
    approve: boolean,
  ): Promise<DeviceEnrollmentDecisionResponse> {
    if (principal.role !== 'superadmin' && !isManagerRole(principal.role)) {
      throw new ForbiddenException('Only an owner, admin, or superadmin can manage devices');
    }
    return this.database.transaction(async (client) => {
      const challenge = await client.query<{
        id: string;
        store_id: string;
        user_id: string;
        device_id: string;
        device_name: string;
        expires_at: Date;
        approved_at: Date | null;
        denied_at: Date | null;
      }>('SELECT * FROM device_enrollment_challenges WHERE id = $1 FOR UPDATE', [challengeId]);
      const row = challenge.rows[0];
      if (!row) throw new NotFoundException('Device enrollment request not found');
      if (principal.role !== 'superadmin' && principal.storeId !== row.store_id) {
        throw new ForbiddenException('You do not have access to this enrollment request');
      }
      if (row.approved_at || row.denied_at || row.expires_at.getTime() <= Date.now()) {
        throw new ConflictException('Device enrollment request is no longer pending');
      }
      if (approve) {
        await this.upsertDevice(client, {
          deviceId: row.device_id,
          storeId: row.store_id,
          deviceName: row.device_name,
          registeredByUserId: principal.userId,
        });
        await client.query(
          'UPDATE device_enrollment_challenges SET approved_at = now(), decided_by_user_id = $2 WHERE id = $1',
          [challengeId, principal.userId],
        );
      } else {
        await client.query(
          'UPDATE device_enrollment_challenges SET denied_at = now(), decided_by_user_id = $2 WHERE id = $1',
          [challengeId, principal.userId],
        );
      }
      return { challengeId, status: approve ? 'approved' : 'denied' };
    });
  }

  async revokeDevice(principal: SessionPrincipal, deviceId: string) {
    if (principal.role !== 'superadmin' && !isManagerRole(principal.role)) {
      throw new ForbiddenException('Only an owner, admin, or superadmin can revoke devices');
    }
    const storeId = principal.role === 'superadmin'
      ? (await this.database.query<{ store_id: string }>('SELECT store_id FROM devices WHERE id = $1', [deviceId])).rows[0]?.store_id
      : principal.storeId;
    if (!storeId) throw new NotFoundException('Device not found');
    await this.database.transaction(async (client) => {
      const device = await client.query<{ id: string }>('SELECT id FROM devices WHERE id = $1 AND store_id = $2 FOR UPDATE', [deviceId, storeId]);
      if (!device.rows[0]) throw new NotFoundException('Device not found');
      await client.query(
        'UPDATE devices SET revoked_at = now(), revoked_by_user_id = $3, updated_at = now() WHERE id = $1 AND store_id = $2',
        [deviceId, storeId, principal.userId],
      );
      await client.query(
        `UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, now()), revoke_reason = 'device_revoked'
          WHERE store_id = $1 AND device_id = $2 AND revoked_at IS NULL`,
        [storeId, deviceId],
      );
    });
    return { revoked: true as const, deviceId };
  }

  async confirmManagerAction(
    principal: SessionPrincipal,
    input: ManagerActionConfirmationRequest,
  ): Promise<ManagerActionConfirmationResponse> {
    if (!isManagerRole(principal.role)) throw new ForbiddenException('Only an owner or admin can approve stock adjustments');
    const membership = await this.findMembershipById(principal.userId, principal.storeId);
    if (!membership?.password_hash || !verifySecret(input.password, membership.password_hash)) {
      throw new UnauthorizedException('Password is incorrect');
    }
    const proof = await this.jwt.signAsync(
      {
        sub: principal.userId,
        storeId: principal.storeId,
        deviceId: principal.deviceId,
        action: input.action,
        clientCommandId: input.clientCommandId,
      },
      {
        secret: this.config.getOrThrow<string>('JWT_SECRET'),
        issuer: 'gma-pos-api',
        audience: 'gma-manager-action',
        expiresIn: '2m',
      },
    );
    return { proof };
  }

  async verifyManagerActionProof(
    principal: SessionPrincipal,
    proof: string | undefined,
    action: ManagerActionConfirmationRequest['action'],
    clientCommandId: string,
  ) {
    if (!isManagerRole(principal.role)) throw new ForbiddenException('Only an owner or admin can adjust stock');
    if (!proof) throw new ForbiddenException('Enter your password to approve this stock adjustment');
    try {
      const payload = await this.jwt.verifyAsync<{
        sub: string;
        storeId: string;
        deviceId: string;
        action: ManagerActionConfirmationRequest['action'];
        clientCommandId: string;
      }>(proof, {
        secret: this.config.getOrThrow<string>('JWT_SECRET'),
        issuer: 'gma-pos-api',
        audience: 'gma-manager-action',
      });
      if (
        payload.sub !== principal.userId
        || payload.storeId !== principal.storeId
        || payload.deviceId !== principal.deviceId
        || payload.action !== action
        || payload.clientCommandId !== clientCommandId
      ) throw new Error('Approval does not match this adjustment');
    } catch {
      throw new ForbiddenException('Password approval expired or does not match this stock adjustment');
    }
  }

  async listSuperadminStores(): Promise<SuperadminStoreSummary[]> {
    const result = await this.database.query<{
      id: string;
      name: string;
      is_active: boolean;
      owner_count: string;
      admin_count: string;
      cashier_count: string;
      last_activity_at: Date | null;
      last_device_seen_at: Date | null;
      latest_backup_at: Date | null;
      backup_count: string;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT stores.id, stores.name, stores.is_active, stores.created_at, stores.updated_at,
              (SELECT COUNT(*) FROM store_memberships sm JOIN users u ON u.id = sm.user_id WHERE sm.store_id = stores.id AND sm.role = 'owner' AND sm.is_active AND u.is_active) AS owner_count,
              (SELECT COUNT(*) FROM store_memberships sm JOIN users u ON u.id = sm.user_id WHERE sm.store_id = stores.id AND sm.role = 'admin' AND sm.is_active AND u.is_active) AS admin_count,
              (SELECT COUNT(*) FROM store_memberships sm JOIN users u ON u.id = sm.user_id WHERE sm.store_id = stores.id AND sm.role = 'cashier' AND sm.is_active AND u.is_active) AS cashier_count,
              GREATEST(stores.updated_at, COALESCE((SELECT MAX(created_at) FROM sync_events WHERE store_id = stores.id), stores.updated_at)) AS last_activity_at,
              (SELECT MAX(last_seen_at) FROM devices WHERE store_id = stores.id) AS last_device_seen_at,
              (SELECT MAX(created_at) FROM backups WHERE store_id = stores.id AND backup_kind = 'server_snapshot') AS latest_backup_at,
              (SELECT COUNT(*) FROM backups WHERE store_id = stores.id AND backup_kind = 'server_snapshot') AS backup_count
         FROM stores
        ORDER BY stores.created_at DESC`,
    );
    return result.rows.map((row) => this.mapSuperadminStore(row));
  }

  async getSuperadminStoreDetails(storeId: string) {
    return {
      store: await this.getSuperadminStore(storeId),
      staff: await this.listSuperadminStaff(storeId),
    };
  }

  async setSuperadminStoreStatus(storeId: string, isActive: boolean, actor?: SessionPrincipal) {
    await this.database.transaction(async (client) => {
      const store = await client.query<{ id: string; name: string; is_active: boolean }>('SELECT id, name, is_active FROM stores WHERE id = $1 FOR UPDATE', [storeId]);
      if (!store.rows[0]) throw new NotFoundException('Store not found');
      await client.query('UPDATE stores SET is_active = $2, updated_at = now() WHERE id = $1', [storeId, isActive]);
      if (!isActive) {
        await client.query(
          `UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, now()), revoke_reason = 'store_suspended'
            WHERE store_id = $1 AND revoked_at IS NULL`,
          [storeId],
        );
      }
      if (actor) await this.activity?.record(client, {
        storeId,
        actor,
        category: 'store',
        action: isActive ? 'store.reactivated' : 'store.suspended',
        entityType: 'store',
        entityId: storeId,
        summary: `${isActive ? 'Reactivated' : 'Suspended'} store ${store.rows[0].name}`,
        details: { before: { isActive: store.rows[0].is_active }, after: { isActive } },
      });
    });
    return this.getSuperadminStoreDetails(storeId);
  }

  async deleteStoreAsSuperadmin(storeId: string) {
    return this.database.transaction(async (client) => {
      const store = await client.query<{ id: string; is_active: boolean }>(
        'SELECT id, is_active FROM stores WHERE id = $1 FOR UPDATE',
        [storeId],
      );
      if (!store.rows[0]) throw new NotFoundException('Store not found');
      if (store.rows[0].is_active) {
        throw new ConflictException('Disable the store before deleting it');
      }

      const operationalData = await client.query<{ count: string }>(
        `SELECT (
           (SELECT COUNT(*) FROM products WHERE store_id = $1) +
           (SELECT COUNT(*) FROM customers WHERE store_id = $1) +
           (SELECT COUNT(*) FROM sales WHERE store_id = $1) +
           (SELECT COUNT(*) FROM expenses WHERE store_id = $1) +
           (SELECT COUNT(*) FROM backups WHERE store_id = $1) +
           (SELECT COUNT(*) FROM devices WHERE store_id = $1)
         )::text AS count`,
        [storeId],
      );
      if (Number(operationalData.rows[0]?.count ?? '0') > 0) {
        throw new ConflictException('Only an empty store can be deleted');
      }

      const memberships = await client.query<{ user_id: string }>(
        'SELECT user_id FROM store_memberships WHERE store_id = $1',
        [storeId],
      );
      const userIds = memberships.rows.map((row) => row.user_id);

      await client.query('DELETE FROM stores WHERE id = $1', [storeId]);
      if (userIds.length > 0) {
        await client.query(
          `DELETE FROM users
            WHERE id = ANY($1::uuid[])
              AND is_superadmin = false
              AND NOT EXISTS (
                SELECT 1 FROM store_memberships WHERE store_memberships.user_id = users.id
              )`,
          [userIds],
        );
      }

      return { deleted: true as const, storeId };
    });
  }

  async setSuperadminStaffStatus(storeId: string, userId: string, isActive: boolean, actor?: SessionPrincipal) {
    await this.database.transaction(async (client) => {
      const membership = await client.query<{ role: Role; is_active: boolean; display_name: string }>(
        `SELECT store_memberships.role, store_memberships.is_active, users.display_name
           FROM store_memberships JOIN users ON users.id = store_memberships.user_id
          WHERE store_memberships.store_id = $1 AND store_memberships.user_id = $2`,
        [storeId, userId],
      );
      if (!membership.rows[0]) throw new NotFoundException('Staff account not found');
      if (!['owner', 'admin'].includes(membership.rows[0].role)) {
        throw new ConflictException('Superadmin lifecycle controls are limited to owners and admins');
      }
      if (!isActive && membership.rows[0].role === 'owner') {
        const activeOwners = await client.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count
             FROM store_memberships
            WHERE store_id = $1 AND role = 'owner' AND is_active = true AND user_id <> $2`,
          [storeId, userId],
        );
        if (Number(activeOwners.rows[0]?.count ?? 0) === 0) {
          throw new ConflictException('The store must keep at least one active owner');
        }
      }
      await client.query(
        'UPDATE store_memberships SET is_active = $3, updated_at = now() WHERE store_id = $1 AND user_id = $2',
        [storeId, userId, isActive],
      );
      if (isActive) {
        await client.query('UPDATE users SET is_active = true, updated_at = now() WHERE id = $1', [userId]);
      } else {
        await client.query(
          `UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, now()), revoke_reason = 'staff_disabled'
            WHERE store_id = $1 AND user_id = $2 AND revoked_at IS NULL`,
          [storeId, userId],
        );
      }
      await client.query('UPDATE stores SET updated_at = now() WHERE id = $1', [storeId]);
      if (actor) await this.activity?.record(client, {
        storeId,
        actor,
        category: 'staff',
        action: isActive ? 'staff.reactivated' : 'staff.disabled',
        entityType: 'user',
        entityId: userId,
        summary: `${isActive ? 'Reactivated' : 'Disabled'} ${membership.rows[0].display_name}'s ${membership.rows[0].role} access`,
        details: { targetDisplayName: membership.rows[0].display_name, targetRole: membership.rows[0].role, before: { isActive: membership.rows[0].is_active }, after: { isActive } },
      });
    });
    return this.getSuperadminStoreDetails(storeId);
  }

  async resetSuperadminStaffSecret(storeId: string, userId: string, password: string, actor?: SessionPrincipal) {
    await this.database.transaction(async (client) => {
      const membership = await client.query<{ role: Role; display_name: string }>(
        `SELECT store_memberships.role, users.display_name
           FROM store_memberships JOIN users ON users.id = store_memberships.user_id
          WHERE store_memberships.store_id = $1 AND store_memberships.user_id = $2`,
        [storeId, userId],
      );
      if (!membership.rows[0]) throw new NotFoundException('Staff account not found');
      if (!['owner', 'admin'].includes(membership.rows[0].role)) {
        throw new ConflictException('Superadmin credential resets are limited to owners and admins');
      }
      await client.query(
        'UPDATE users SET password_hash = $1, credential_version = credential_version + 1, updated_at = now() WHERE id = $2',
        [hashSecret(password), userId],
      );
      await client.query(
        `UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, now()), revoke_reason = 'credential_reset'
          WHERE user_id = $1 AND revoked_at IS NULL`,
        [userId],
      );
      await client.query('UPDATE stores SET updated_at = now() WHERE id = $1', [storeId]);
      if (actor) await this.activity?.record(client, {
        storeId,
        actor,
        category: 'staff',
        action: 'staff.credential_reset',
        entityType: 'user',
        entityId: userId,
        summary: `Reset ${membership.rows[0].display_name}'s password`,
        details: { targetDisplayName: membership.rows[0].display_name, targetRole: membership.rows[0].role, credentialType: 'password' },
      });
    });
    return this.getSuperadminStoreDetails(storeId);
  }

  private async listSuperadminStaff(storeId: string): Promise<StaffMember[]> {
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

  async createStoreAsSuperadmin(input: SuperadminCreateStoreRequest, actor?: SessionPrincipal) {
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
      if (actor) await this.activity?.record(client, {
        storeId,
        actor,
        category: 'store',
        action: 'store.created',
        entityType: 'store',
        entityId: storeId,
        summary: `Created store ${input.storeName.trim()}`,
        details: { ownerDisplayName: input.ownerDisplayName.trim() },
      });
      return { storeId, userId };
    });
    return {
      store: await this.getSuperadminStore(result.storeId),
      staff: await this.getStaffMember(result.storeId, result.userId),
    };
  }

  async createStoreStaffAsSuperadmin(storeId: string, input: SuperadminStaffInput, actor?: SessionPrincipal) {
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
      if (actor) await this.activity?.record(client, {
        storeId,
        actor,
        category: 'staff',
        action: 'staff.created',
        entityType: 'user',
        entityId: userId,
        summary: `Created ${input.role} account for ${input.displayName.trim()}`,
        details: { targetDisplayName: input.displayName.trim(), targetRole: input.role },
      });
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
    this.requireManager(actor);
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
      await this.activity?.record(client, {
        storeId,
        actor,
        category: 'staff',
        action: 'staff.created',
        entityType: 'user',
        entityId: userId,
        summary: `Created ${input.role} account for ${input.displayName.trim()}`,
        details: { targetDisplayName: input.displayName.trim(), targetRole: input.role },
      });
      return userId;
    });
    return this.getStaffMember(storeId, userId);
  }

  async listStaff(storeId: string, actor: SessionPrincipal) {
    this.requireManager(actor);
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
    this.requireManager(actor);
    if (actor.userId === userId) throw new ConflictException('You cannot disable your own account');
    await this.database.transaction(async (client) => {
      const membership = await client.query<{ role: Role; display_name: string }>(
        `SELECT store_memberships.role, users.display_name
           FROM store_memberships JOIN users ON users.id = store_memberships.user_id
          WHERE store_memberships.store_id = $1 AND store_memberships.user_id = $2`,
        [storeId, userId],
      );
      if (!membership.rows[0]) throw new NotFoundException('Staff account not found');
      if (membership.rows[0].role === 'owner') throw new ConflictException('Owner access cannot be disabled here');
      await client.query('UPDATE store_memberships SET is_active = false, updated_at = now() WHERE store_id = $1 AND user_id = $2', [storeId, userId]);
      await client.query('UPDATE users SET is_active = false, updated_at = now() WHERE id = $1', [userId]);
      await client.query(
        `UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, now()), revoke_reason = 'staff_disabled'
          WHERE store_id = $1 AND user_id = $2 AND revoked_at IS NULL`,
        [storeId, userId],
      );
      await this.touchStore(client, storeId, actor.userId);
      await this.activity?.record(client, {
        storeId,
        actor,
        category: 'staff',
        action: 'staff.disabled',
        entityType: 'user',
        entityId: userId,
        summary: `Disabled ${membership.rows[0].display_name}'s ${membership.rows[0].role} access`,
        details: { targetDisplayName: membership.rows[0].display_name, targetRole: membership.rows[0].role, before: { isActive: true }, after: { isActive: false } },
      });
    });
    return this.getStaffMember(storeId, userId);
  }

  async resetStaffSecret(storeId: string, actor: SessionPrincipal, userId: string, input: { password?: string; pin?: string }) {
    this.requireManager(actor);
    await this.database.transaction(async (client) => {
      const membership = await client.query<{ role: Role; display_name: string }>(
        `SELECT store_memberships.role, users.display_name
           FROM store_memberships JOIN users ON users.id = store_memberships.user_id
          WHERE store_memberships.store_id = $1 AND store_memberships.user_id = $2`,
        [storeId, userId],
      );
      if (!membership.rows[0]) throw new NotFoundException('Staff account not found');
      const role = membership.rows[0].role;
      if (role === 'cashier') {
        if (!input.pin) throw new ConflictException('Cashiers require a new PIN');
        await client.query(
          'UPDATE users SET pin_hash = $1, credential_version = credential_version + 1, updated_at = now() WHERE id = $2',
          [hashSecret(input.pin), userId],
        );
      } else {
        if (!input.password) throw new ConflictException('Admins require a new password');
        await client.query(
          'UPDATE users SET password_hash = $1, credential_version = credential_version + 1, updated_at = now() WHERE id = $2',
          [hashSecret(input.password), userId],
        );
      }
      await client.query(
        `UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, now()), revoke_reason = 'credential_reset'
          WHERE user_id = $1 AND revoked_at IS NULL`,
        [userId],
      );
      await this.touchStore(client, storeId, actor.userId);
      await this.activity?.record(client, {
        storeId,
        actor,
        category: 'staff',
        action: 'staff.credential_reset',
        entityType: 'user',
        entityId: userId,
        summary: `Reset ${membership.rows[0].display_name}'s ${role === 'cashier' ? 'PIN' : 'password'}`,
        details: { targetDisplayName: membership.rows[0].display_name, targetRole: role, credentialType: role === 'cashier' ? 'pin' : 'password' },
      });
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

  private async issueSession(principal: SessionPrincipal & { role: StoreRole }): Promise<IssuedSession> {
    const user = await this.database.query<{ credential_version: number }>('SELECT credential_version FROM users WHERE id = $1', [principal.userId]);
    if (!user.rows[0]) throw new UnauthorizedException('Your account is inactive');
    return this.createSession(principal, user.rows[0].credential_version);
  }

  private issueSuperadminSession(user: SuperadminUserRow): Promise<IssuedSession> {
    return this.createSession({
      userId: user.id,
      storeId: '',
      deviceId: '',
      role: 'superadmin',
      displayName: user.display_name,
      email: user.email,
      staffCode: null,
    }, user.credential_version);
  }

  private async createSession(principal: SessionPrincipal, credentialVersion: number): Promise<IssuedSession> {
    const sessionId = crypto.randomUUID();
    const refreshToken = randomBytes(32).toString('base64url');
    await this.database.query(
      `INSERT INTO auth_sessions
       (id, user_id, store_id, device_id, credential_version, refresh_token_hash, refresh_expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, now() + interval '30 days')`,
      [sessionId, principal.userId, principal.role === 'superadmin' ? null : principal.storeId,
        principal.role === 'superadmin' ? null : principal.deviceId, credentialVersion, this.hashRefreshToken(refreshToken)],
    );
    const withSession = { ...principal, sessionId };
    const token = await this.signAccessToken(withSession, sessionId, credentialVersion);
    return { session: await this.buildSession(withSession, token), refreshToken };
  }

  private signAccessToken(principal: SessionPrincipal, sessionId: string, credentialVersion: number) {
    return this.jwt.signAsync(
      {
        jti: sessionId,
        sub: principal.userId,
        storeId: principal.role === 'superadmin' ? null : principal.storeId,
        deviceId: principal.role === 'superadmin' ? null : principal.deviceId,
        role: principal.role,
        displayName: principal.displayName,
        email: principal.email,
        staffCode: principal.staffCode,
        credentialVersion,
        accessNonce: crypto.randomUUID(),
      },
      {
        secret: this.config.getOrThrow<string>('JWT_SECRET'),
        issuer: 'gma-pos-api',
        expiresIn: '30m',
      },
    );
  }

  private hashRefreshToken(token: string) {
    return createHash('sha256').update(token).digest('hex');
  }

  private async findSuperadminByEmail(email: string) {
    const result = await this.database.query<SuperadminUserRow>(
      `SELECT id, display_name, email, password_hash, is_active, is_superadmin, credential_version
         FROM users
        WHERE LOWER(email) = LOWER($1) AND is_superadmin = true
        LIMIT 1`,
      [email],
    );
    return result.rows[0] ?? null;
  }

  private async findSuperadminById(userId: string) {
    const result = await this.database.query<SuperadminUserRow>(
      `SELECT id, display_name, email, password_hash, is_active, is_superadmin, credential_version
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
              users.password_hash, users.pin_hash, users.is_active AS user_active, users.credential_version,
              store_memberships.is_active AS membership_active, stores.is_active AS store_active, stores.maintenance_mode, store_memberships.role,
              stores.id AS store_id, stores.name AS store_name, stores.created_at AS store_created_at, stores.updated_at AS store_updated_at
         FROM users
         JOIN store_memberships ON store_memberships.user_id = users.id
         JOIN stores ON stores.id = store_memberships.store_id
        WHERE LOWER(users.email) = LOWER($1)
        ORDER BY stores.is_active DESC, CASE store_memberships.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, store_memberships.created_at ASC
        LIMIT 1`,
      [email],
    );
    return result.rows[0] ?? null;
  }

  private async findMembershipByStaffCode(storeId: string, staffCode: string) {
    const result = await this.database.query<MembershipRow>(
      `SELECT users.id AS user_id, users.display_name, users.email, users.staff_code,
              users.password_hash, users.pin_hash, users.is_active AS user_active, users.credential_version,
              store_memberships.is_active AS membership_active, stores.is_active AS store_active, stores.maintenance_mode, store_memberships.role,
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
              users.password_hash, users.pin_hash, users.is_active AS user_active, users.credential_version,
              store_memberships.is_active AS membership_active, stores.is_active AS store_active, stores.maintenance_mode, store_memberships.role,
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

  private async requireEnrolledDevice(membership: MembershipRow, deviceId: string, deviceName: string) {
    const existing = await this.database.query<DeviceRow>('SELECT * FROM devices WHERE id = $1', [deviceId]);
    const device = existing.rows[0];
    if (device) {
      if (device.store_id !== membership.store_id) throw new ConflictException('This device is already linked to another store');
      if (!device.is_enrolled || device.revoked_at) throw new UnauthorizedException('This device is no longer active');
      await this.database.query(
        'UPDATE devices SET name = $3, last_seen_at = now(), updated_at = now() WHERE id = $1 AND store_id = $2',
        [deviceId, membership.store_id, deviceName],
      );
      return;
    }
    const pending = await this.database.query<{ id: string; expires_at: Date }>(
      `SELECT id, expires_at
         FROM device_enrollment_challenges
        WHERE store_id = $1 AND user_id = $2 AND device_id = $3
          AND approved_at IS NULL AND denied_at IS NULL AND expires_at > now()
        ORDER BY created_at DESC LIMIT 1`,
      [membership.store_id, membership.user_id, deviceId],
    );
    const challengeId = pending.rows[0]?.id ?? crypto.randomUUID();
    const expiresAt = pending.rows[0]?.expires_at ?? new Date(Date.now() + 10 * 60 * 1000);
    if (!pending.rows[0]) {
      await this.database.query(
        `INSERT INTO device_enrollment_challenges
         (id, store_id, user_id, device_id, device_name, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [challengeId, membership.store_id, membership.user_id, deviceId, deviceName, expiresAt],
      );
    }
    throw new HttpException({
      statusCode: HttpStatus.PRECONDITION_REQUIRED,
      code: 'device_enrollment_required',
      challengeId,
      expiresAt: expiresAt.toISOString(),
      message: 'A manager must approve this browser before it can sign in.',
    }, HttpStatus.PRECONDITION_REQUIRED);
  }

  private async upsertDevice(client: { query: DatabaseService['query'] }, input: {
    deviceId: string;
    storeId: string;
    deviceName: string;
    registeredByUserId: string;
  }) {
    const result = await client.query<{ id: string }>(
      `INSERT INTO devices (id, store_id, name, registered_by_user_id, is_enrolled, revoked_at, created_at, updated_at, last_seen_at)
       VALUES ($1, $2, $3, $4, true, NULL, now(), now(), now())
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         is_enrolled = true,
         revoked_at = NULL,
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
      is_active: boolean;
      owner_count: string;
      admin_count: string;
      cashier_count: string;
      last_activity_at: Date | null;
      last_device_seen_at: Date | null;
      latest_backup_at: Date | null;
      backup_count: string;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT stores.id, stores.name, stores.is_active, stores.created_at, stores.updated_at,
              (SELECT COUNT(*) FROM store_memberships sm JOIN users u ON u.id = sm.user_id WHERE sm.store_id = stores.id AND sm.role = 'owner' AND sm.is_active AND u.is_active) AS owner_count,
              (SELECT COUNT(*) FROM store_memberships sm JOIN users u ON u.id = sm.user_id WHERE sm.store_id = stores.id AND sm.role = 'admin' AND sm.is_active AND u.is_active) AS admin_count,
              (SELECT COUNT(*) FROM store_memberships sm JOIN users u ON u.id = sm.user_id WHERE sm.store_id = stores.id AND sm.role = 'cashier' AND sm.is_active AND u.is_active) AS cashier_count,
              GREATEST(stores.updated_at, COALESCE((SELECT MAX(created_at) FROM sync_events WHERE store_id = stores.id), stores.updated_at)) AS last_activity_at,
              (SELECT MAX(last_seen_at) FROM devices WHERE store_id = stores.id) AS last_device_seen_at,
              (SELECT MAX(created_at) FROM backups WHERE store_id = stores.id AND backup_kind = 'server_snapshot') AS latest_backup_at,
              (SELECT COUNT(*) FROM backups WHERE store_id = stores.id AND backup_kind = 'server_snapshot') AS backup_count
         FROM stores
        WHERE stores.id = $1
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

  private requireManager(actor: SessionPrincipal) {
    if (!isManagerRole(actor.role)) throw new ForbiddenException('You do not have access to this action');
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
    is_active: boolean;
    owner_count: string;
    admin_count: string;
    cashier_count: string;
    last_activity_at: Date | null;
    last_device_seen_at: Date | null;
    latest_backup_at: Date | null;
    backup_count: string;
    created_at: Date;
    updated_at: Date;
  }): SuperadminStoreSummary {
    return {
      id: row.id,
      name: row.name,
      isActive: row.is_active,
      ownerCount: Number(row.owner_count),
      adminCount: Number(row.admin_count),
      cashierCount: Number(row.cashier_count),
      lastActivityAt: row.last_activity_at?.toISOString() ?? null,
      lastDeviceSeenAt: row.last_device_seen_at?.toISOString() ?? null,
      latestBackupAt: row.latest_backup_at?.toISOString() ?? null,
      backupCount: Number(row.backup_count),
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
