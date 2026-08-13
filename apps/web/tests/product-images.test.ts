import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, saveSession } from '../lib/db';
import { compressProductImage, flushProductImageDeletes, flushProductImageUploads } from '../lib/product-images';

const now = '2026-08-12T00:00:00.000Z';

describe('product image compression', () => {
  afterEach(() => vi.restoreAllMocks());

  it('resizes the longest edge to 640px and emits an image below 100 KB', async () => {
    const close = vi.fn();
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ width: 1280, height: 640, close }));
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage, imageSmoothingEnabled: false, imageSmoothingQuality: 'low' } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback, type) => callback(new Blob(['compressed'], { type: type || 'image/webp' })));

    const result = await compressProductImage(new File(['source'], 'product.jpg', { type: 'image/jpeg' }));
    expect(result.width).toBe(640);
    expect(result.height).toBe(320);
    expect(result.blob.size).toBeLessThanOrEqual(100 * 1024);
    expect(drawImage).toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
  });

  it('rejects non-image and unreadable files with actionable errors', async () => {
    await expect(compressProductImage(new File(['x'], 'notes.txt', { type: 'text/plain' }))).rejects.toThrow('valid image');
    vi.stubGlobal('createImageBitmap', vi.fn().mockRejectedValue(new Error('decode failed')));
    await expect(compressProductImage(new File(['x'], 'broken.jpg', { type: 'image/jpeg' }))).rejects.toThrow('could not be read');
  });
});

describe('product image sync queue', () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
    await saveSession({
      token: 'test-token',
      store: { id: 'store', name: 'GMA Store', createdAt: now, updatedAt: now },
      device: { id: 'device', storeId: 'store', name: 'Test browser', firstSyncedAt: now, lastSeenAt: now, createdAt: now, updatedAt: now },
      user: { id: 'user', displayName: 'Owner', email: 'owner@example.com', staffCode: null, role: 'owner' },
    });
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await db.delete();
  });

  it('uploads pending blobs before allowing queued deletion', async () => {
    const productId = '71551dba-4438-47b8-995c-8fe6153e307c';
    const revision = '94e72a36-4f59-4e69-8d87-3067a5e42fae';
    await db.productImages.put({
      productId, revision, blob: new Blob(['image'], { type: 'image/webp' }), contentType: 'image/webp',
      byteLength: 5, syncStatus: 'pending', updatedAt: new Date().toISOString(),
    });
    await db.productImageQueue.bulkPut([
      { id: `upload:${productId}:${revision}`, productId, revision, operation: 'upload', attemptCount: 0, lastAttemptAt: null },
      { id: `delete:${productId}:old`, productId, revision: 'old', operation: 'delete', attemptCount: 0, lastAttemptAt: null },
    ]);
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(flushProductImageUploads()).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining(`/stores/store/products/${productId}/images/${revision}`), expect.objectContaining({ method: 'PUT' }));
    expect((await db.productImages.get(productId))?.syncStatus).toBe('synced');
    expect(await db.productImageQueue.where('operation').equals('delete').count()).toBe(1);

    await flushProductImageDeletes();
    expect(fetchMock).toHaveBeenLastCalledWith(expect.stringContaining(`/stores/store/products/${productId}/images/old`), expect.objectContaining({ method: 'DELETE' }));
    expect(await db.productImageQueue.count()).toBe(0);
  });
});
