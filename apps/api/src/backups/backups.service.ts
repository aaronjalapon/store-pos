import { Injectable, Optional, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { BackupSummary } from '@gma/contracts';
import { DatabaseService } from '../database/database.service';
import type { SessionPrincipal } from '../auth/auth.types';
import { StoreDataService } from '../stores/store-data.service';
import { ObjectStorage } from '../storage/object-storage';
import { ActivityService } from '../activity/activity.service';
import { ConfigService } from '@nestjs/config';
import { type BackupAttachment, decryptSnapshot, encryptSnapshot, parseBackupKeys } from './backup-envelope';

@Injectable()
export class BackupsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly storage: ObjectStorage,
    private readonly data: StoreDataService,
    @Optional() private readonly activity?: ActivityService,
    @Optional() private readonly config?: ConfigService,
  ) {}

  async create(principal: SessionPrincipal) {
    // All tables and attachment metadata must describe the same committed state.
    const { snapshot, attachments } = await this.database.transaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const snapshot = await this.data.loadSnapshot(principal.storeId, { includeInactiveUnits: true, client });
      const attachments = await this.loadAttachments(principal.storeId, client);
      return { snapshot, attachments };
    });
    const now = new Date().toISOString();
    const backupId = crypto.randomUUID();
    const keyring = this.keyring();
    const body = encryptSnapshot({
      createdAt: now, storeId: principal.storeId, snapshot, attachments, schemaVersion: 3,
      keyId: keyring.activeKeyId, key: keyring.keys[keyring.activeKeyId],
    });
    const maxBytes = Number(this.config?.get<string>('BACKUP_MAX_BYTES') ?? 100 * 1024 * 1024);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024 || body.byteLength > maxBytes) {
      throw new ServiceUnavailableException(`Encrypted backup exceeds the configured ${maxBytes} byte limit`);
    }
    const checksum = createHash('sha256').update(body).digest('hex');
    const objectKey = `server-backups/${principal.storeId}/${backupId}.backup.json`;
    const operationId = crypto.randomUUID();
    const stagingKey = `staging/backups/${principal.storeId}/${operationId}`;
    await this.storage.put(stagingKey, body, 'application/vnd.gma-pos.backup+json');
    const persist = async (client: { query: DatabaseService['query'] }) => {
      await client.query(
        `INSERT INTO backups
         (id, store_id, device_id, schema_version, object_key, byte_length, checksum_sha256, created_at, backup_kind,
          format_version, encryption_key_id, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'server_snapshot', 1, $9, 'staging')
         ON CONFLICT (id) DO NOTHING`,
        [backupId, principal.storeId, principal.deviceId, 3, objectKey, body.byteLength, checksum, now, keyring.activeKeyId],
      );
      await client.query(
        `INSERT INTO object_operations
         (id, store_id, operation, object_kind, staging_key, final_key, content_type)
         VALUES ($1, $2, 'finalize', 'backup', $3, $4, 'application/vnd.gma-pos.backup+json')`,
        [operationId, principal.storeId, stagingKey, objectKey],
      );
      await this.activity?.record(client, {
        storeId: principal.storeId,
        actor: principal,
        category: 'backups',
        action: 'backup.created',
        entityType: 'backup',
        entityId: backupId,
        summary: 'Created a server backup',
        details: { byteLength: body.byteLength, schemaVersion: 3, formatVersion: 1, keyId: keyring.activeKeyId },
      });
    };
    try {
      if (this.activity) await this.database.transaction(persist);
      else await persist(this.database);
    } catch (error) {
      await this.storage.delete(stagingKey).catch(() => undefined);
      throw error;
    }
    try {
      await this.storage.copy(stagingKey, objectKey, 'application/vnd.gma-pos.backup+json');
      await this.database.transaction(async (client) => {
        await client.query("UPDATE object_operations SET status = 'complete', attempt_count = attempt_count + 1, updated_at = now() WHERE id = $1", [operationId]);
        await client.query("UPDATE backups SET status = 'complete' WHERE id = $1", [backupId]);
      });
    } catch (error) {
      await this.database.query(
        `UPDATE object_operations SET status = 'failed', attempt_count = attempt_count + 1,
          last_error = $2, next_attempt_at = now() + interval '1 minute', updated_at = now() WHERE id = $1`,
        [operationId, error instanceof Error ? error.message.slice(0, 500) : 'Object finalization failed'],
      ).catch(() => undefined);
      throw new ServiceUnavailableException('Backup is staged but could not be finalized; it will be retried');
    }
    await this.applyRetention(principal.storeId);
    return this.getSummary(principal.storeId);
  }

  async getSummary(storeId: string): Promise<BackupSummary> {
    const result = await this.database.query<{ latest_backup_at: Date | null; backup_count: string }>(
      `SELECT MAX(created_at) AS latest_backup_at, COUNT(*)::text AS backup_count
         FROM backups
        WHERE store_id = $1 AND backup_kind = 'server_snapshot' AND status = 'complete'`,
      [storeId],
    );
    return {
      latestBackupAt: result.rows[0]?.latest_backup_at?.toISOString() ?? null,
      backupCount: Number(result.rows[0]?.backup_count ?? '0'),
    };
  }

  async loadForRestore(storeId: string, backupId: string) {
    const result = await this.database.query<{ object_key: string; checksum_sha256: string; status: string }>(
      'SELECT object_key, checksum_sha256, status FROM backups WHERE store_id = $1 AND id = $2',
      [storeId, backupId],
    );
    const backup = result.rows[0];
    if (!backup || backup.status !== 'complete') throw new ServiceUnavailableException('Backup is not available for restore');
    const object = await this.storage.get(backup.object_key);
    const checksum = createHash('sha256').update(object.body).digest('hex');
    if (checksum !== backup.checksum_sha256) throw new ServiceUnavailableException('Backup checksum does not match');
    return decryptSnapshot(object.body, this.keyring().keys, storeId);
  }

  async applyRetention(storeId: string) {
    const rows = await this.database.query<{ id: string; object_key: string; created_at: Date }>(
      `SELECT id, object_key, created_at FROM backups
        WHERE store_id = $1 AND backup_kind = 'server_snapshot' AND status = 'complete'
        ORDER BY created_at DESC`,
      [storeId],
    );
    const keep = new Set<string>();
    const daily = new Set<string>();
    const monthly = new Set<string>();
    for (const row of rows.rows) {
      // Store operations use Manila calendar days, including the midnight boundary.
      const localDate = new Date(row.created_at.getTime() + 8 * 60 * 60 * 1000).toISOString();
      const day = localDate.slice(0, 10);
      const month = localDate.slice(0, 7);
      if (daily.size < 30 && !daily.has(day)) {
        daily.add(day);
        keep.add(row.id);
      }
      if (monthly.size < 12 && !monthly.has(month)) {
        monthly.add(month);
        keep.add(row.id);
      }
    }
    const expired = rows.rows.filter((row) => !keep.has(row.id));
    for (const row of expired) {
      await this.database.transaction(async (client) => {
        await client.query("UPDATE backups SET status = 'expired' WHERE id = $1 AND status = 'complete'", [row.id]);
        await client.query(
          `INSERT INTO object_operations (id, store_id, operation, object_kind, final_key)
           VALUES ($1, $2, 'delete', 'backup', $3)`,
          [crypto.randomUUID(), storeId, row.object_key],
        );
      });
    }
  }

  private keyring() {
    return parseBackupKeys(
      this.config?.get<string>('BACKUP_ENCRYPTION_KEYS_JSON') ?? process.env.BACKUP_ENCRYPTION_KEYS_JSON,
      this.config?.get<string>('BACKUP_ENCRYPTION_ACTIVE_KEY_ID') ?? process.env.BACKUP_ENCRYPTION_ACTIVE_KEY_ID,
      (this.config?.get<string>('NODE_ENV') ?? process.env.NODE_ENV) === 'production',
    );
  }

  private async loadAttachments(storeId: string, client: Pick<DatabaseService, 'query'>): Promise<BackupAttachment[]> {
    const metadata = await client.query<{
      kind: 'product_image' | 'qrph_image';
      product_id: string | null;
      revision: string;
      object_key: string;
      readable_key: string;
      content_type: string;
      byte_length: number;
    }>(
      `SELECT 'product_image'::text AS kind, image.product_id, image.revision, image.object_key,
              COALESCE((SELECT operation.staging_key FROM object_operations operation
                WHERE operation.store_id = image.store_id AND operation.final_key = image.object_key
                  AND operation.operation = 'finalize' AND operation.status <> 'complete'
                ORDER BY operation.created_at DESC LIMIT 1), image.object_key) AS readable_key,
              image.content_type, image.byte_length
         FROM product_images image WHERE image.store_id = $1
       UNION ALL
       SELECT 'qrph_image'::text AS kind, NULL::uuid AS product_id, settings.image_revision AS revision,
              settings.object_key,
              COALESCE((SELECT operation.staging_key FROM object_operations operation
                WHERE operation.store_id = settings.store_id AND operation.final_key = settings.object_key
                  AND operation.operation = 'finalize' AND operation.status <> 'complete'
                ORDER BY operation.created_at DESC LIMIT 1), settings.object_key) AS readable_key,
              settings.content_type, settings.byte_length
         FROM qrph_payment_settings settings WHERE settings.store_id = $1`,
      [storeId],
    );
    const attachments: BackupAttachment[] = [];
    for (const row of metadata.rows) {
      const object = await this.storage.get(row.readable_key);
      const body = Buffer.from(object.body);
      if (body.byteLength !== row.byte_length) {
        throw new ServiceUnavailableException(`Backup attachment ${row.object_key} does not match its metadata`);
      }
      attachments.push({
        kind: row.kind,
        ...(row.product_id ? { productId: row.product_id } : {}),
        revision: row.revision,
        contentType: row.content_type,
        byteLength: body.byteLength,
        checksumSha256: createHash('sha256').update(body).digest('hex'),
        bodyBase64: body.toString('base64'),
      });
    }
    return attachments;
  }
}
