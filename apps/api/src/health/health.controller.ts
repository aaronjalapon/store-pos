import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { ObjectStorage } from '../storage/object-storage';

@Controller('health')
export class HealthController {
  constructor(private readonly database: DatabaseService, private readonly storage: ObjectStorage) {}

  @Get(['', 'live'])
  health() {
    return { status: 'ok', service: 'gma-pos-api' };
  }

  private dependencyCheck?: Promise<void>;

  @Get('ready')
  async ready() {
    // Share a stalled probe across callers instead of accumulating DB/S3 work.
    const check = this.dependencyCheck ??= this.checkDependencies().finally(() => {
      this.dependencyCheck = undefined;
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        check,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Readiness deadline exceeded')), 3_000);
        }),
      ]);
      return { status: 'ready', service: 'gma-pos-api', database: 'ok', objectStorage: 'ok' };
    } catch {
      throw new ServiceUnavailableException({ status: 'not_ready', service: 'gma-pos-api' });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async checkDependencies() {
    const [database] = await Promise.all([
      this.database.query<{ migration: string | null }>(
        'SELECT MAX(filename) AS migration FROM schema_migrations',
      ),
      this.storage.check(),
    ]);
    if (database.rows[0]?.migration !== '010_sync_retention_state.sql') {
      throw new Error('Database schema is not current');
    }
  }
}
