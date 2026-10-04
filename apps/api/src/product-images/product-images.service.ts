import { BadRequestException, Injectable, NotFoundException, Optional, PayloadTooLargeException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { SessionPrincipal } from '../auth/auth.types';
import { DatabaseService } from '../database/database.service';
import { ObjectStorage } from '../storage/object-storage';
import { ActivityService } from '../activity/activity.service';
import sharp from 'sharp';

const ALLOWED_CONTENT_TYPES = new Set(['image/webp', 'image/jpeg']);

@Injectable()
export class ProductImagesService {
  constructor(
    private readonly storage: ObjectStorage,
    private readonly config: ConfigService,
    private readonly database: DatabaseService,
    @Optional() private readonly activity?: ActivityService,
  ) {}

  async put(principal: SessionPrincipal, productId: string, revision: string, body: Uint8Array, contentType: string) {
    const normalizedType = contentType.split(';')[0].trim().toLowerCase();
    if (!ALLOWED_CONTENT_TYPES.has(normalizedType)) throw new BadRequestException('Product image must be WebP or JPEG');
    const maxBytes = Number(this.config.get('PRODUCT_IMAGE_MAX_INPUT_BYTES', 4 * 1024 * 1024));
    if (!body.byteLength) throw new BadRequestException('Product image is empty');
    if (body.byteLength > maxBytes) throw new PayloadTooLargeException(`Product image must be ${maxBytes} bytes or smaller`);
    const product = await this.database.query<{ id: string; image_revision: string | null }>(
      'SELECT id, image_revision FROM products WHERE id = $1 AND store_id = $2',
      [productId, principal.storeId],
    );
    if (!product.rows[0]) throw new NotFoundException('Product not found');
    if (product.rows[0].image_revision !== revision) {
      throw new BadRequestException('Product image revision does not match the product record');
    }
    const previous = await this.database.query<{ object_key: string }>(
      'SELECT object_key FROM product_images WHERE product_id = $1 AND store_id = $2',
      [productId, principal.storeId],
    );
    if (!this.hasValidSignature(body, normalizedType)) throw new BadRequestException('Product image content does not match its MIME type');
    let encoded: Buffer;
    try {
      encoded = await sharp(body, { failOn: 'error', limitInputPixels: 16_000_000 })
        .rotate()
        .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 80, effort: 4 })
        .toBuffer();
    } catch {
      throw new BadRequestException('Product image could not be decoded');
    }
    const maxOutputBytes = Number(this.config.get('PRODUCT_IMAGE_MAX_OUTPUT_BYTES', 200 * 1024));
    if (encoded.byteLength > maxOutputBytes) throw new PayloadTooLargeException(`Processed product image must be ${maxOutputBytes} bytes or smaller`);
    const operationId = crypto.randomUUID();
    const stagingKey = `staging/product-images/${principal.storeId}/${operationId}`;
    const objectKey = this.objectKey(principal.storeId, productId, revision);
    await this.storage.put(stagingKey, encoded, 'image/webp');
    const persist = async (client: { query: DatabaseService['query'] }) => {
      await client.query(
        `INSERT INTO product_images (store_id, product_id, revision, object_key, content_type, byte_length, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, now())
         ON CONFLICT (store_id, product_id) DO UPDATE SET
           revision = EXCLUDED.revision,
           object_key = EXCLUDED.object_key,
           content_type = EXCLUDED.content_type,
           byte_length = EXCLUDED.byte_length,
           updated_at = now()`,
        [principal.storeId, productId, revision, objectKey, 'image/webp', encoded.byteLength],
      );
      await client.query(
        `INSERT INTO object_operations
         (id, store_id, operation, object_kind, staging_key, final_key, content_type)
         VALUES ($1, $2, 'finalize', 'product_image', $3, $4, 'image/webp')`,
        [operationId, principal.storeId, stagingKey, objectKey],
      );
      if (previous.rows[0] && previous.rows[0].object_key !== objectKey) {
        await client.query(
          `INSERT INTO object_operations (id, store_id, operation, object_kind, final_key)
           VALUES ($1, $2, 'delete', 'product_image', $3)`,
          [crypto.randomUUID(), principal.storeId, previous.rows[0].object_key],
        );
      }
      await this.activity?.record(client, {
        storeId: principal.storeId,
        actor: principal,
        category: 'products',
        action: 'product.image_uploaded',
        entityType: 'product',
        entityId: productId,
        summary: 'Updated a product image',
        details: { revision, contentType: 'image/webp', byteLength: encoded.byteLength },
      });
    };
    try {
      if (this.activity) await this.database.transaction(persist);
      else await persist(this.database);
    } catch (error) {
      await this.storage.delete(stagingKey).catch(() => undefined);
      throw error;
    }
    await this.finalizeOperation(operationId, stagingKey, objectKey, 'image/webp').catch(() => undefined);
    return { accepted: true, productId, revision, byteLength: encoded.byteLength, contentType: 'image/webp' as const };
  }

  async get(principal: SessionPrincipal, productId: string, revision: string) {
    const metadata = await this.database.query<{ object_key: string }>(
      'SELECT object_key FROM product_images WHERE store_id = $1 AND product_id = $2 AND revision = $3',
      [principal.storeId, productId, revision],
    );
    if (!metadata.rows[0]) throw new NotFoundException('Product image not found');
    const pending = await this.database.query<{ staging_key: string | null }>(
      `SELECT staging_key FROM object_operations
        WHERE store_id = $1 AND final_key = $2 AND operation = 'finalize' AND status <> 'complete'
        ORDER BY created_at DESC LIMIT 1`,
      [principal.storeId, metadata.rows[0].object_key],
    );
    return this.storage.get(pending.rows[0]?.staging_key ?? metadata.rows[0].object_key);
  }

  async delete(principal: SessionPrincipal, productId: string, revision: string) {
    const objectKey = this.objectKey(principal.storeId, productId, revision);
    const persist = async (client: { query: DatabaseService['query'] }) => {
      const deleted = await client.query(
        'DELETE FROM product_images WHERE store_id = $1 AND product_id = $2 AND revision = $3 RETURNING object_key',
        [principal.storeId, productId, revision],
      );
      if (!deleted.rows[0]) throw new NotFoundException('Product image not found');
      await client.query(
        `INSERT INTO object_operations (id, store_id, operation, object_kind, final_key)
         VALUES ($1, $2, 'delete', 'product_image', $3)`,
        [crypto.randomUUID(), principal.storeId, objectKey],
      );
      await this.activity?.record(client, {
        storeId: principal.storeId,
        actor: principal,
        category: 'products',
        action: 'product.image_deleted',
        entityType: 'product',
        entityId: productId,
        summary: 'Removed a product image',
        details: { revision },
      });
    };
    if (this.activity) await this.database.transaction(persist);
    else await persist(this.database);
    try {
      await this.storage.delete(objectKey);
      await this.database.query(
        `UPDATE object_operations SET status = 'complete', attempt_count = attempt_count + 1, updated_at = now()
          WHERE store_id = $1 AND final_key = $2 AND operation = 'delete' AND status = 'pending'`,
        [principal.storeId, objectKey],
      );
    } catch {
      // The durable outbox remains pending for the reconciler.
    }
    return { deleted: true, productId, revision };
  }

  private objectKey(storeId: string, productId: string, revision: string) {
    return `product-images/${storeId}/${productId}/${revision}`;
  }

  private hasValidSignature(body: Uint8Array, contentType: string) {
    if (contentType === 'image/jpeg') return body.length >= 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff;
    return body.length >= 12
      && new TextDecoder().decode(body.slice(0, 4)) === 'RIFF'
      && new TextDecoder().decode(body.slice(8, 12)) === 'WEBP';
  }

  private async finalizeOperation(operationId: string, stagingKey: string, finalKey: string, contentType: string) {
    await this.storage.copy(stagingKey, finalKey, contentType);
    await this.database.query(
      `UPDATE object_operations
          SET status = 'complete', attempt_count = attempt_count + 1, last_error = NULL, updated_at = now()
        WHERE id = $1`,
      [operationId],
    );
  }
}
