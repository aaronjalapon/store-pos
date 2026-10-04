import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID } from 'node:crypto';
import type { SessionPrincipal, } from '../auth/auth.types';
import { DatabaseService } from '../database/database.service';
import { ObjectStorage } from '../storage/object-storage';
import { StoresService } from '../stores/stores.service';
import { storeSnapshotSchema } from '../stores/legacy-import.schema';
import type { StoreSnapshot } from '@gma/contracts';
import type { BackupAttachment } from './backup-envelope';
import { BackupsService } from './backups.service';

@Injectable()
export class BackupRestoreService {
  constructor(
    private readonly database: DatabaseService,
    private readonly backups: BackupsService,
    private readonly stores: StoresService,
    private readonly storage: ObjectStorage,
    private readonly config: ConfigService,
  ) {}

  async restore(storeId: string, backupId: string, options: { dryRun: boolean }) {
    const loaded = await this.backups.loadForRestore(storeId, backupId);
    if (loaded.envelope.schemaVersion !== 3) throw new BadRequestException('Backup schema version is not supported');
    const parsed = storeSnapshotSchema.safeParse(loaded.snapshot);
    if (!parsed.success) throw new BadRequestException({ message: 'Backup snapshot validation failed', errors: parsed.error.flatten() });
    const attachments = this.validateAttachments(parsed.data, loaded.attachments);
    const snapshot = this.snapshotWithAvailableAttachments(parsed.data, attachments);
    const principal = await this.restorePrincipal(storeId);
    const summary = {
      products: snapshot.products.length,
      sales: snapshot.sales.length,
      customers: snapshot.customers.length,
      utangEntries: snapshot.utangEntries.length,
      expenses: snapshot.expenses.length,
      attachments: attachments.length,
    };
    if (options.dryRun) return { dryRun: true as const, storeId, backupId, summary };

    const preRestore = await this.backups.create(principal);
    await this.database.query('UPDATE stores SET maintenance_mode = true, updated_at = now() WHERE id = $1', [storeId]);
    const staged = attachments.map((attachment) => this.prepareAttachment(storeId, attachment));
    try {
      for (const attachment of staged) {
        await this.storage.put(attachment.stagingKey, attachment.body, attachment.contentType);
      }
      await this.database.transaction(async (client) => {
        await this.stores.clearOperationalData(client, storeId, staged.map((attachment) => attachment.finalKey));
        await this.stores.insertSnapshot(client, principal, snapshot, { preserveActors: true });
        for (const attachment of staged) {
          if (attachment.kind === 'product_image') {
            await client.query(
              `INSERT INTO product_images
               (store_id, product_id, revision, object_key, content_type, byte_length, updated_at)
               VALUES ($1, $2, $3, $4, $5, $6, now())`,
              [storeId, attachment.productId, attachment.revision, attachment.finalKey, attachment.contentType, attachment.body.byteLength],
            );
          } else {
            await client.query(
              `INSERT INTO qrph_payment_settings
               (store_id, image_revision, object_key, content_type, byte_length, updated_at, updated_by_user_id)
               VALUES ($1, $2, $3, $4, $5, now(), $6)`,
              [storeId, attachment.revision, attachment.finalKey, attachment.contentType, attachment.body.byteLength, principal.userId],
            );
          }
          await client.query(
            `INSERT INTO object_operations
             (id, store_id, operation, object_kind, staging_key, final_key, content_type)
             VALUES ($1, $2, 'finalize', $3, $4, $5, $6)`,
            [attachment.operationId, storeId, attachment.kind, attachment.stagingKey, attachment.finalKey, attachment.contentType],
          );
        }
        await client.query('UPDATE backups SET restored_at = now(), restore_verified_at = now() WHERE id = $1 AND store_id = $2', [backupId, storeId]);
      });
      let recoveringAttachments = 0;
      for (const attachment of staged) {
        try {
          await this.storage.copy(attachment.stagingKey, attachment.finalKey, attachment.contentType);
          await this.database.query(
            `UPDATE object_operations SET status = 'complete', attempt_count = attempt_count + 1,
              last_error = NULL, updated_at = now() WHERE id = $1`,
            [attachment.operationId],
          );
        } catch {
          recoveringAttachments += 1;
        }
      }
      return { dryRun: false as const, storeId, backupId, preRestore, summary, recoveringAttachments };
    } catch (error) {
      await Promise.allSettled(staged.map((attachment) => this.storage.delete(attachment.stagingKey)));
      throw error;
    } finally {
      await this.database.query('UPDATE stores SET maintenance_mode = false, updated_at = now() WHERE id = $1', [storeId]);
    }
  }

  private validateAttachments(snapshot: StoreSnapshot, candidates: BackupAttachment[] | undefined) {
    const attachments = candidates ?? [];
    const maxBytes = Number(this.config.get<string>('BACKUP_MAX_BYTES') ?? 100 * 1024 * 1024);
    const productById = new Map(snapshot.products.map((product) => [product.id, product]));
    const seen = new Set<string>();
    let totalBytes = 0;
    for (const attachment of attachments) {
      const body = Buffer.from(attachment.bodyBase64, 'base64');
      const key = `${attachment.kind}:${attachment.productId ?? ''}:${attachment.revision}`;
      if (seen.has(key)) throw new BadRequestException('Backup contains duplicate attachments');
      seen.add(key);
      totalBytes += body.byteLength;
      if (body.byteLength !== attachment.byteLength
        || createHash('sha256').update(body).digest('hex') !== attachment.checksumSha256) {
        throw new BadRequestException('Backup attachment checksum does not match');
      }
      if (attachment.kind === 'product_image') {
        const product = attachment.productId ? productById.get(attachment.productId) : undefined;
        if (!product || product.imageRevision !== attachment.revision || !['image/webp', 'image/jpeg'].includes(attachment.contentType)) {
          throw new BadRequestException('Backup product image attachment is invalid');
        }
      } else if (!snapshot.paymentSettings
        || snapshot.paymentSettings.imageRevision !== attachment.revision
        || !['image/png', 'image/webp', 'image/jpeg'].includes(attachment.contentType)) {
        throw new BadRequestException('Backup QR image attachment is invalid');
      }
    }
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024 || totalBytes > maxBytes) {
      throw new BadRequestException('Backup attachments exceed the configured size limit');
    }
    return attachments;
  }

  private snapshotWithAvailableAttachments(snapshot: StoreSnapshot, attachments: BackupAttachment[]): StoreSnapshot {
    const productAttachments = new Set(
      attachments.filter((attachment) => attachment.kind === 'product_image')
        .map((attachment) => `${attachment.productId}:${attachment.revision}`),
    );
    const qrRevision = attachments.find((attachment) => attachment.kind === 'qrph_image')?.revision;
    return {
      ...snapshot,
      products: snapshot.products.map((product) => product.imageRevision
        && productAttachments.has(`${product.id}:${product.imageRevision}`)
        ? product
        : { ...product, imageRevision: null }),
      paymentSettings: snapshot.paymentSettings?.imageRevision === qrRevision ? snapshot.paymentSettings : null,
    };
  }

  private prepareAttachment(storeId: string, attachment: BackupAttachment) {
    const operationId = randomUUID();
    const body = Buffer.from(attachment.bodyBase64, 'base64');
    return {
      ...attachment,
      operationId,
      body,
      stagingKey: `staging/restore/${storeId}/${operationId}`,
      finalKey: attachment.kind === 'product_image'
        ? `product-images/${storeId}/${attachment.productId}/${attachment.revision}`
        : `payment-settings/${storeId}/qrph/${attachment.revision}`,
    };
  }

  private async restorePrincipal(storeId: string): Promise<SessionPrincipal> {
    const result = await this.database.query<{
      user_id: string;
      display_name: string;
      email: string | null;
      staff_code: string | null;
      device_id: string;
    }>(
      `SELECT users.id AS user_id, users.display_name, users.email, users.staff_code, devices.id AS device_id
         FROM store_memberships memberships
         JOIN users ON users.id = memberships.user_id AND users.is_active
         JOIN devices ON devices.store_id = memberships.store_id AND devices.is_enrolled AND devices.revoked_at IS NULL
        WHERE memberships.store_id = $1 AND memberships.role = 'owner' AND memberships.is_active
        ORDER BY devices.last_seen_at DESC LIMIT 1`,
      [storeId],
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundException('Restore requires an active owner and enrolled device');
    return {
      userId: row.user_id, storeId, deviceId: row.device_id, role: 'owner',
      displayName: row.display_name, email: row.email, staffCode: row.staff_code,
    };
  }
}
