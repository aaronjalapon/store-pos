import { Injectable, Optional } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { BackupSummary } from '@gma/contracts';
import { DatabaseService } from '../database/database.service';
import type { SessionPrincipal } from '../auth/auth.types';
import { StoreDataService } from '../stores/store-data.service';
import { ObjectStorage } from '../storage/object-storage';
import { ActivityService } from '../activity/activity.service';

@Injectable()
export class BackupsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly storage: ObjectStorage,
    private readonly data: StoreDataService,
    @Optional() private readonly activity?: ActivityService,
  ) {}

  async create(principal: SessionPrincipal) {
    const snapshot = await this.data.loadSnapshot(principal.storeId);
    const now = new Date().toISOString();
    const backupId = crypto.randomUUID();
    const body = new TextEncoder().encode(JSON.stringify({
      createdAt: now,
      storeId: principal.storeId,
      snapshot,
    }));
    const checksum = createHash('sha256').update(body).digest('hex');
    const objectKey = `server-backups/${principal.storeId}/${backupId}.json`;
    await this.storage.put(objectKey, body, 'application/json');
    const persist = async (client: { query: DatabaseService['query'] }) => {
      await client.query(
        `INSERT INTO backups
         (id, store_id, device_id, schema_version, object_key, byte_length, checksum_sha256, created_at, backup_kind)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'server_snapshot')
         ON CONFLICT (id) DO NOTHING`,
        [backupId, principal.storeId, principal.deviceId, 2, objectKey, body.byteLength, checksum, now],
      );
      await this.activity?.record(client, {
        storeId: principal.storeId,
        actor: principal,
        category: 'backups',
        action: 'backup.created',
        entityType: 'backup',
        entityId: backupId,
        summary: 'Created a server backup',
        details: { byteLength: body.byteLength, schemaVersion: 2 },
      });
    };
    if (this.activity) await this.database.transaction(persist);
    else await persist(this.database);
    return this.getSummary(principal.storeId);
  }

  async getSummary(storeId: string): Promise<BackupSummary> {
    const result = await this.database.query<{ latest_backup_at: Date | null; backup_count: string }>(
      `SELECT MAX(created_at) AS latest_backup_at, COUNT(*)::text AS backup_count
         FROM backups
        WHERE store_id = $1 AND backup_kind = 'server_snapshot'`,
      [storeId],
    );
    return {
      latestBackupAt: result.rows[0]?.latest_backup_at?.toISOString() ?? null,
      backupCount: Number(result.rows[0]?.backup_count ?? '0'),
    };
  }
}
