export interface BackupMetadata {
  id: string;
  storeId: string;
  deviceId: string;
  schemaVersion: number;
  objectKey: string;
  byteLength: number;
  checksumSha256: string;
  createdAt: string;
}

export abstract class BackupRepository {
  abstract findById(storeId: string, backupId: string): Promise<BackupMetadata | null>;
  abstract findLatest(storeId: string): Promise<BackupMetadata | null>;
  abstract insert(metadata: BackupMetadata): Promise<void>;
}
