import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { AuthRateLimitService } from '../auth/auth-rate-limit.service';

@Injectable()
export class RetentionService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;

  constructor(private readonly database: DatabaseService, private readonly limits: AuthRateLimitService) {}

  onModuleInit() { this.scheduleNext(); }
  onModuleDestroy() { if (this.timer) clearTimeout(this.timer); }

  private scheduleNext() {
    const now = new Date();
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 19, 30, 0));
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    this.timer = setTimeout(async () => {
      await this.prune().catch(() => undefined);
      this.scheduleNext();
    }, next.getTime() - now.getTime());
    this.timer.unref();
  }

  async prune() {
    await this.limits.prune();
    await this.database.query("DELETE FROM processed_commands WHERE processed_at < now() - interval '30 days'");
    await this.database.transaction(async (client) => {
      await client.query(
        `INSERT INTO store_sync_state (store_id, min_available_cursor, updated_at)
         SELECT store_id, MAX(sync_cursor), now()
           FROM entity_changes
          WHERE changed_at < now() - interval '30 days'
          GROUP BY store_id
         ON CONFLICT (store_id) DO UPDATE SET
           min_available_cursor = GREATEST(store_sync_state.min_available_cursor, EXCLUDED.min_available_cursor),
           updated_at = now()`,
      );
      await client.query("DELETE FROM entity_changes WHERE changed_at < now() - interval '30 days'");
    });
  }
}
