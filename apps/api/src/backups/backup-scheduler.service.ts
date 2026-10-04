import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { StoreRole } from '@gma/contracts';
import { DatabaseService } from '../database/database.service';
import { BackupsService } from './backups.service';

@Injectable()
export class BackupSchedulerService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;

  constructor(private readonly database: DatabaseService, private readonly backups: BackupsService) {}

  onModuleInit() { this.scheduleNext(); }
  onModuleDestroy() { if (this.timer) clearTimeout(this.timer); }

  private scheduleNext() {
    const now = new Date();
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 18, 0, 0));
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    this.timer = setTimeout(async () => {
      try { await this.createDailyBackups(); }
      catch { Logger.warn('Daily backup scheduling failed; retrying at the next scheduled run', 'BackupSchedulerService'); }
      finally { this.scheduleNext(); }
    }, next.getTime() - now.getTime());
    this.timer.unref();
  }

  async createDailyBackups() {
    const targets = await this.database.query<{
      store_id: string;
      user_id: string;
      display_name: string;
      email: string | null;
      staff_code: string | null;
      role: StoreRole;
      device_id: string;
    }>(
      `SELECT DISTINCT ON (stores.id) stores.id AS store_id, users.id AS user_id, users.display_name,
              users.email, users.staff_code, memberships.role, devices.id AS device_id
         FROM stores
         JOIN store_memberships memberships ON memberships.store_id = stores.id AND memberships.is_active
         JOIN users ON users.id = memberships.user_id AND users.is_active
         JOIN devices ON devices.store_id = stores.id AND devices.is_enrolled AND devices.revoked_at IS NULL
        WHERE stores.is_active AND memberships.role IN ('owner', 'admin')
        ORDER BY stores.id, CASE memberships.role WHEN 'owner' THEN 0 ELSE 1 END, devices.last_seen_at DESC`,
    );
    for (const target of targets.rows) {
      await this.backups.create({
        userId: target.user_id,
        storeId: target.store_id,
        deviceId: target.device_id,
        role: target.role,
        displayName: target.display_name,
        email: target.email,
        staffCode: target.staff_code,
      }).catch(() => undefined);
    }
  }
}
