import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ProductImagesService } from '../src/product-images/product-images.service';
import { ObjectStorage } from '../src/storage/object-storage';

class MemoryStorage extends ObjectStorage {
  objects = new Map<string, { body: Uint8Array; contentType: string }>();
  async put(key: string, body: Uint8Array, contentType: string) { this.objects.set(key, { body, contentType }); }
  async get(key: string) { return this.objects.get(key)!; }
  async delete(key: string) { this.objects.delete(key); }
}

describe('ProductImagesService', () => {
  const principal = {
    userId: '8d124f6a-8e06-4d2d-8b10-395367d9d1aa',
    storeId: '158f0a73-2d33-4dda-97d1-996b392d1bb5',
    deviceId: 'db9cfa04-a4f3-420c-a389-906dad485802',
    role: 'owner' as const,
    displayName: 'Owner',
    email: 'owner@example.com',
    staffCode: null,
  };
  const otherStore = { ...principal, storeId: '258f0a73-2d33-4dda-97d1-996b392d1bb5' };
  const productId = '71551dba-4438-47b8-995c-8fe6153e307c';
  const revision = '94e72a36-4f59-4e69-8d87-3067a5e42fae';

  it('stores, retrieves, and deletes an image within the authenticated store scope', async () => {
    const storage = new MemoryStorage();
    const service = new ProductImagesService(storage, new ConfigService({ PRODUCT_IMAGE_MAX_BYTES: 20 }), { query: jest.fn().mockResolvedValue({ rows: [] }) } as never);
    const image = Uint8Array.from([82, 73, 70, 70, 4, 0, 0, 0, 87, 69, 66, 80]);
    await expect(service.put(principal, productId, revision, image, 'image/webp')).resolves.toMatchObject({ accepted: true, byteLength: 12 });
    await expect(service.get(principal, productId, revision)).resolves.toEqual({ body: image, contentType: 'image/webp' });
    await expect(service.get(otherStore, productId, revision)).resolves.toBeUndefined();
    await service.delete(principal, productId, revision);
    await expect(service.get(principal, productId, revision)).resolves.toBeUndefined();
  });

  it('rejects unsupported and oversized image bodies', async () => {
    const service = new ProductImagesService(new MemoryStorage(), new ConfigService({ PRODUCT_IMAGE_MAX_BYTES: 4 }), { query: jest.fn().mockResolvedValue({ rows: [] }) } as never);
    await expect(service.put(principal, productId, revision, Uint8Array.from([1]), 'image/png')).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.put(principal, productId, revision, Uint8Array.from([0xff, 0xd8, 0xff, 0, 1]), 'image/jpeg')).rejects.toBeInstanceOf(PayloadTooLargeException);
    await expect(service.put(principal, productId, revision, Uint8Array.from([1, 2, 3]), 'image/jpeg')).rejects.toBeInstanceOf(BadRequestException);
  });
});
