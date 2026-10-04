import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { ObjectStorage } from './object-storage';

@Injectable()
export class ObjectOperationsService implements OnModuleInit, OnModuleDestroy {
  private running = false;
  private timer?: NodeJS.Timeout;

  constructor(private readonly database: DatabaseService, private readonly storage: ObjectStorage) {}

  onModuleInit() {
    this.timer = setInterval(() => {
      void this.reconcile().catch(() => Logger.warn('Object reconciliation failed; retrying on the next interval', 'ObjectOperationsService'));
    }, 60_000);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async reconcile() {
    if (this.running) return;
    this.running = true;
    try {
      const pending = await this.database.query<{
        id: string;
        status: string;
        operation: 'finalize' | 'delete';
        object_kind: 'product_image' | 'qrph_image' | 'backup';
        staging_key: string | null;
        final_key: string;
        content_type: string | null;
        attempt_count: number;
      }>(
        `SELECT id, status, operation, object_kind, staging_key, final_key, content_type, attempt_count
           FROM object_operations
          WHERE (status IN ('pending', 'failed') AND next_attempt_at <= now())
             OR (status = 'processing' AND updated_at < now() - interval '10 minutes')
             OR (status = 'complete' AND staging_key IS NOT NULL)
          ORDER BY created_at ASC LIMIT 20`,
      );
      for (const operation of pending.rows) await this.process(operation);
    } finally {
      this.running = false;
    }
  }

  private async process(operation: {
    id: string;
    status: string;
    operation: 'finalize' | 'delete';
    object_kind: 'product_image' | 'qrph_image' | 'backup';
    staging_key: string | null;
    final_key: string;
    content_type: string | null;
    attempt_count: number;
  }) {
    if (operation.status === 'complete') {
      // Keep staging durable until the completion transaction commits. Cleanup is
      // itself retryable, including a lost acknowledgement after object deletion.
      if (operation.staging_key) {
        await this.storage.delete(operation.staging_key);
        await this.database.query('UPDATE object_operations SET staging_key = NULL WHERE id = $1 AND status = \'complete\'', [operation.id]);
      }
      return;
    }
    await this.database.query("UPDATE object_operations SET status = 'processing', updated_at = now() WHERE id = $1", [operation.id]);
    try {
      if (operation.operation === 'finalize') {
        if (!operation.staging_key) throw new Error('Finalize operation has no staging key');
        await this.storage.copy(operation.staging_key, operation.final_key, operation.content_type ?? undefined);
      } else {
        await this.storage.delete(operation.final_key);
      }
      await this.database.transaction(async (client) => {
        await client.query(
          `UPDATE object_operations SET status = 'complete', attempt_count = attempt_count + 1,
            last_error = NULL, updated_at = now() WHERE id = $1`,
          [operation.id],
        );
        if (operation.object_kind === 'backup' && operation.operation === 'finalize') {
          await client.query("UPDATE backups SET status = 'complete' WHERE object_key = $1 AND status = 'staging'", [operation.final_key]);
        }
      });
    } catch (error) {
      const retrySeconds = Math.min(3600, 2 ** Math.min(operation.attempt_count + 1, 10) * 30);
      await this.database.query(
        `UPDATE object_operations SET status = 'failed', attempt_count = attempt_count + 1,
          last_error = $2, next_attempt_at = now() + make_interval(secs => $3), updated_at = now()
          WHERE id = $1`,
        [operation.id, error instanceof Error ? error.message.slice(0, 500) : 'Object operation failed', retrySeconds],
      );
    }
  }
}
