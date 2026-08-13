import { BadRequestException, Injectable, PayloadTooLargeException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { SessionPrincipal } from '../auth/auth.types';
import { DatabaseService } from '../database/database.service';
import { ObjectStorage } from '../storage/object-storage';

const ALLOWED_CONTENT_TYPES = new Set(['image/webp', 'image/jpeg']);

@Injectable()
export class ProductImagesService {
  constructor(
    private readonly storage: ObjectStorage,
    private readonly config: ConfigService,
    private readonly database: DatabaseService,
  ) {}

  async put(principal: SessionPrincipal, productId: string, revision: string, body: Uint8Array, contentType: string) {
    const normalizedType = contentType.split(';')[0].trim().toLowerCase();
    if (!ALLOWED_CONTENT_TYPES.has(normalizedType)) throw new BadRequestException('Product image must be WebP or JPEG');
    const maxBytes = Number(this.config.get('PRODUCT_IMAGE_MAX_BYTES', 100 * 1024));
    if (!body.byteLength) throw new BadRequestException('Product image is empty');
    if (body.byteLength > maxBytes) throw new PayloadTooLargeException(`Product image must be ${maxBytes} bytes or smaller`);
    if (!this.hasValidSignature(body, normalizedType)) throw new BadRequestException('Product image content does not match its MIME type');
    const objectKey = this.objectKey(principal.storeId, productId, revision);
    await this.storage.put(objectKey, body, normalizedType);
    await this.database.query(
      `INSERT INTO product_images (store_id, product_id, revision, object_key, content_type, byte_length, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (store_id, product_id) DO UPDATE SET
         revision = EXCLUDED.revision,
         object_key = EXCLUDED.object_key,
         content_type = EXCLUDED.content_type,
         byte_length = EXCLUDED.byte_length,
         updated_at = now()`,
      [principal.storeId, productId, revision, objectKey, normalizedType, body.byteLength],
    );
    return { accepted: true, productId, revision, byteLength: body.byteLength };
  }

  get(principal: SessionPrincipal, productId: string, revision: string) {
    return this.storage.get(this.objectKey(principal.storeId, productId, revision));
  }

  async delete(principal: SessionPrincipal, productId: string, revision: string) {
    await this.storage.delete(this.objectKey(principal.storeId, productId, revision));
    await this.database.query('DELETE FROM product_images WHERE store_id = $1 AND product_id = $2 AND revision = $3', [principal.storeId, productId, revision]);
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
}
