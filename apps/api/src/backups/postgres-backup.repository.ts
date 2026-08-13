import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { BackupRepository, type BackupMetadata } from './backup.repository';

interface BackupRow {
  id: string;
  store_id: string;
  device_id: string;
  schema_version: number;
  object_key: string;
  byte_length: number;
  checksum_sha256: string;
  created_at: Date;
}

@Injectable()
export class PostgresBackupRepository extends BackupRepository {
  constructor(private readonly database: DatabaseService) { super(); }

  async findById(storeId: string, backupId: string) {
    const result = await this.database.query<BackupRow>(
      'SELECT * FROM backups WHERE store_id = $1 AND id = $2', [storeId, backupId],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }

  async findLatest(storeId: string) {
    const result = await this.database.query<BackupRow>(
      'SELECT * FROM backups WHERE store_id = $1 ORDER BY created_at DESC LIMIT 1', [storeId],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }

  async insert(metadata: BackupMetadata) {
    await this.database.query(
      `INSERT INTO backups
       (id, store_id, device_id, schema_version, object_key, byte_length, checksum_sha256, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO NOTHING`,
      [metadata.id, metadata.storeId, metadata.deviceId, metadata.schemaVersion, metadata.objectKey,
        metadata.byteLength, metadata.checksumSha256, metadata.createdAt],
    );
  }
}

function mapRow(row: BackupRow): BackupMetadata {
  return {
    id: row.id,
    storeId: row.store_id,
    deviceId: row.device_id,
    schemaVersion: row.schema_version,
    objectKey: row.object_key,
    byteLength: row.byte_length,
    checksumSha256: row.checksum_sha256,
    createdAt: row.created_at.toISOString(),
  };
}
