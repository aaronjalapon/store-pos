import { BadRequestException } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { StoreSnapshot } from '@gma/contracts';

export interface BackupEnvelopeV1 {
  formatVersion: 1;
  storeId: string;
  schemaVersion: number;
  createdAt: string;
  keyId: string;
  algorithm: 'A256GCM';
  compression: 'gzip';
  nonce: string;
  tag: string;
  ciphertext: string;
}

export interface BackupAttachment {
  kind: 'product_image' | 'qrph_image';
  productId?: string;
  revision: string;
  contentType: string;
  byteLength: number;
  checksumSha256: string;
  bodyBase64: string;
}

interface BackupPayloadV1 {
  snapshot: StoreSnapshot;
  attachments: BackupAttachment[];
}

export function encryptSnapshot(input: {
  storeId: string;
  schemaVersion: number;
  createdAt: string;
  snapshot: StoreSnapshot;
  attachments?: BackupAttachment[];
  keyId: string;
  key: Buffer;
}) {
  if (input.key.byteLength !== 32) throw new Error('Backup encryption key must be 32 bytes');
  const nonce = randomBytes(12);
  const header = `${input.storeId}|${input.schemaVersion}|${input.createdAt}|${input.keyId}`;
  const cipher = createCipheriv('aes-256-gcm', input.key, nonce);
  cipher.setAAD(Buffer.from(header));
  const payload: BackupPayloadV1 = { snapshot: input.snapshot, attachments: input.attachments ?? [] };
  const plaintext = gzipSync(Buffer.from(JSON.stringify(payload)));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const envelope: BackupEnvelopeV1 = {
    formatVersion: 1,
    storeId: input.storeId,
    schemaVersion: input.schemaVersion,
    createdAt: input.createdAt,
    keyId: input.keyId,
    algorithm: 'A256GCM',
    compression: 'gzip',
    nonce: nonce.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
  return Buffer.from(JSON.stringify(envelope));
}

export function decryptSnapshot(body: Uint8Array, keys: Record<string, Buffer>, expectedStoreId?: string) {
  let envelope: BackupEnvelopeV1;
  try {
    envelope = JSON.parse(Buffer.from(body).toString('utf8')) as BackupEnvelopeV1;
  } catch {
    throw new BadRequestException('Backup envelope is not valid JSON');
  }
  if (envelope.formatVersion !== 1 || envelope.algorithm !== 'A256GCM' || envelope.compression !== 'gzip') {
    throw new BadRequestException('Backup format is not supported');
  }
  if (expectedStoreId && envelope.storeId !== expectedStoreId) throw new BadRequestException('Backup belongs to another store');
  const key = keys[envelope.keyId];
  if (!key) throw new BadRequestException('Backup encryption key is unavailable');
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.nonce, 'base64'));
    decipher.setAAD(Buffer.from(`${envelope.storeId}|${envelope.schemaVersion}|${envelope.createdAt}|${envelope.keyId}`));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    const compressed = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
      decipher.final(),
    ]);
    const decoded = JSON.parse(gunzipSync(compressed).toString('utf8')) as StoreSnapshot | BackupPayloadV1;
    // Early encrypted backups stored the snapshot directly. Keep the reader
    // forward-compatible so key rotation never strands those recovery points.
    const payload = decoded && typeof decoded === 'object' && 'snapshot' in decoded
      ? decoded as BackupPayloadV1
      : { snapshot: decoded as StoreSnapshot, attachments: [] };
    return { envelope, snapshot: payload.snapshot, attachments: payload.attachments ?? [] };
  } catch {
    throw new BadRequestException('Backup authentication or decompression failed');
  }
}

export function parseBackupKeys(raw: string | undefined, activeKeyId: string | undefined, production: boolean) {
  if (!raw || !activeKeyId) {
    if (production) throw new Error('Backup encryption keys are required');
    return { activeKeyId: 'development', keys: { development: Buffer.alloc(32, 1) } };
  }
  const parsed = JSON.parse(raw) as Record<string, string>;
  const keys = Object.fromEntries(Object.entries(parsed).map(([id, value]) => [id, Buffer.from(value, 'base64')]));
  if (!keys[activeKeyId] || Object.values(keys).some((key) => key.byteLength !== 32)) {
    throw new Error('Backup encryption keys must contain the active 32-byte key');
  }
  return { activeKeyId, keys };
}
