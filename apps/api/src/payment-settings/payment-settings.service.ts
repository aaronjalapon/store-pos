import { BadRequestException, ForbiddenException, Injectable, NotFoundException, Optional, PayloadTooLargeException } from '@nestjs/common';
import type { QrPhPaymentSettings } from '@gma/contracts';
import type { SessionPrincipal } from '../auth/auth.types';
import { DatabaseService } from '../database/database.service';
import { ObjectStorage } from '../storage/object-storage';
import { ActivityService } from '../activity/activity.service';
import { StoreDataService } from '../stores/store-data.service';

const ALLOWED_CONTENT_TYPES = new Set<QrPhPaymentSettings['contentType']>(['image/png', 'image/webp', 'image/jpeg']);

interface SettingsRow {
  image_revision: string;
  object_key: string;
  content_type: QrPhPaymentSettings['contentType'];
  byte_length: number;
  updated_at: Date;
}

@Injectable()
export class PaymentSettingsService {
  constructor(
    private readonly storage: ObjectStorage,
    private readonly database: DatabaseService,
    private readonly data: StoreDataService,
    @Optional() private readonly activity?: ActivityService,
  ) {}

  async putQr(principal: SessionPrincipal, revision: string, body: Uint8Array, contentType: string) {
    this.requireManager(principal);
    const normalizedType = contentType.split(';')[0].trim().toLowerCase() as QrPhPaymentSettings['contentType'];
    if (!ALLOWED_CONTENT_TYPES.has(normalizedType)) throw new BadRequestException('QR Ph image must be PNG, WebP, or JPEG');
    if (!body.byteLength) throw new BadRequestException('QR Ph image is empty');
    if (body.byteLength > 2 * 1024 * 1024) throw new PayloadTooLargeException('QR Ph image must be 2 MB or smaller');
    if (!this.hasValidSignature(body, normalizedType)) throw new BadRequestException('QR Ph image content does not match its MIME type');

    const previous = await this.current(principal.storeId);
    const objectKey = this.objectKey(principal.storeId, revision);
    await this.storage.put(objectKey, body, normalizedType);
    await this.database.transaction(async (client) => {
      await client.query(
        `INSERT INTO qrph_payment_settings
         (store_id, image_revision, object_key, content_type, byte_length, updated_at, updated_by_user_id)
         VALUES ($1, $2, $3, $4, $5, now(), $6)
         ON CONFLICT (store_id) DO UPDATE SET
           image_revision = EXCLUDED.image_revision,
           object_key = EXCLUDED.object_key,
           content_type = EXCLUDED.content_type,
           byte_length = EXCLUDED.byte_length,
           updated_at = now(),
           updated_by_user_id = EXCLUDED.updated_by_user_id`,
        [principal.storeId, revision, objectKey, normalizedType, body.byteLength, principal.userId],
      );
      await this.data.createSyncEvent(client, principal.storeId, 'payment_settings');
      await this.activity?.record(client, {
        storeId: principal.storeId,
        actor: principal,
        category: 'store',
        action: 'payment.qrph_configured',
        entityType: 'store',
        entityId: principal.storeId,
        summary: 'Updated the store QR Ph code',
        details: { revision, contentType: normalizedType, byteLength: body.byteLength },
      });
    });
    if (previous && previous.object_key !== objectKey) await this.storage.delete(previous.object_key).catch(() => undefined);
    return this.toSettings(principal.storeId, {
      image_revision: revision,
      object_key: objectKey,
      content_type: normalizedType,
      byte_length: body.byteLength,
      updated_at: new Date(),
    });
  }

  async getQr(principal: SessionPrincipal, revision: string) {
    const current = await this.current(principal.storeId);
    if (!current || current.image_revision !== revision) throw new NotFoundException('QR Ph image not found');
    return this.storage.get(current.object_key);
  }

  async deleteQr(principal: SessionPrincipal, revision: string) {
    this.requireManager(principal);
    const current = await this.current(principal.storeId);
    if (!current || current.image_revision !== revision) throw new NotFoundException('QR Ph image not found');
    await this.database.transaction(async (client) => {
      await client.query('DELETE FROM qrph_payment_settings WHERE store_id = $1 AND image_revision = $2', [principal.storeId, revision]);
      await this.data.createSyncEvent(client, principal.storeId, 'payment_settings');
      await this.activity?.record(client, {
        storeId: principal.storeId,
        actor: principal,
        category: 'store',
        action: 'payment.qrph_removed',
        entityType: 'store',
        entityId: principal.storeId,
        summary: 'Removed the store QR Ph code',
        details: { revision },
      });
    });
    await this.storage.delete(current.object_key).catch(() => undefined);
    return { deleted: true, revision };
  }

  private async current(storeId: string) {
    const result = await this.database.query<SettingsRow>('SELECT * FROM qrph_payment_settings WHERE store_id = $1', [storeId]);
    return result.rows[0] ?? null;
  }

  private toSettings(storeId: string, row: SettingsRow): QrPhPaymentSettings {
    return {
      storeId,
      imageRevision: row.image_revision,
      contentType: row.content_type,
      byteLength: row.byte_length,
      updatedAt: row.updated_at.toISOString(),
    };
  }

  private objectKey(storeId: string, revision: string) {
    return `payment-settings/${storeId}/qrph/${revision}`;
  }

  private requireManager(principal: SessionPrincipal) {
    if (!['owner', 'admin'].includes(principal.role)) throw new ForbiddenException('Only owner or admin can configure QR Ph payments');
  }

  private hasValidSignature(body: Uint8Array, contentType: QrPhPaymentSettings['contentType']) {
    if (contentType === 'image/png') {
      return body.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((value, index) => body[index] === value);
    }
    if (contentType === 'image/jpeg') return body.length >= 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff;
    return body.length >= 12
      && new TextDecoder().decode(body.slice(0, 4)) === 'RIFF'
      && new TextDecoder().decode(body.slice(8, 12)) === 'WEBP';
  }
}
