'use client';

import type { Product } from '@gma/contracts';
import { db, getSession, getSessionToken } from './db';

const MAX_IMAGE_BYTES = 100 * 1024;
const MAX_IMAGE_EDGE = 640;
const API_DEFAULT = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

export interface CompressedProductImage {
  revision: string;
  blob: Blob;
  contentType: 'image/webp' | 'image/jpeg';
  width: number;
  height: number;
}

export async function compressProductImage(file: File): Promise<CompressedProductImage> {
  if (!file.type.startsWith('image/')) throw new Error('Choose a valid image file');
  let source: ImageBitmap;
  try {
    source = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new Error('This image could not be read. Try another photo.');
  }

  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(source.width, source.height));
  let width = Math.max(1, Math.round(source.width * scale));
  let height = Math.max(1, Math.round(source.height * scale));
  let result: Blob | null = null;
  let contentType: 'image/webp' | 'image/jpeg' = 'image/webp';

  try {
    for (let sizeAttempt = 0; sizeAttempt < 5 && (!result || result.size > MAX_IMAGE_BYTES); sizeAttempt += 1) {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Image processing is unavailable in this browser');
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';
      context.drawImage(source, 0, 0, width, height);

      for (const quality of [0.86, 0.78, 0.70, 0.62, 0.54, 0.46]) {
        result = await canvasToBlob(canvas, 'image/webp', quality);
        contentType = result?.type === 'image/webp' ? 'image/webp' : 'image/jpeg';
        if (!result || !['image/webp', 'image/jpeg'].includes(result.type)) {
          result = await canvasToBlob(canvas, 'image/jpeg', quality);
          contentType = 'image/jpeg';
        }
        if (result && result.size <= MAX_IMAGE_BYTES) break;
      }
      if (result && result.size <= MAX_IMAGE_BYTES) break;
      width = Math.max(1, Math.round(width * 0.82));
      height = Math.max(1, Math.round(height * 0.82));
    }
  } finally {
    source.close();
  }

  if (!result || result.size > MAX_IMAGE_BYTES) {
    throw new Error('The photo could not be compressed below 100 KB. Try a simpler or smaller image.');
  }
  return { revision: crypto.randomUUID(), blob: result, contentType, width, height };
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number) {
  return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
}

export async function flushProductImageUploads() {
  const configuration = await getImageConfiguration();
  if (!configuration || !navigator.onLine) return false;
  const uploads = await db.productImageQueue.where('operation').equals('upload').toArray();
  for (const item of uploads) {
    const image = await db.productImages.get(item.productId);
    if (!image || image.revision !== item.revision) {
      await db.productImageQueue.delete(item.id);
      continue;
    }
    try {
      const response = await fetch(imageUrl(configuration.apiUrl, configuration.storeId, item.productId, item.revision), {
        method: 'PUT',
        headers: { authorization: `Bearer ${configuration.token}`, 'content-type': image.contentType },
        body: image.blob,
      });
      if (!response.ok) throw new Error(await readableImageError(response));
      await db.transaction('rw', [db.productImages, db.productImageQueue], async () => {
        await db.productImages.update(item.productId, { syncStatus: 'synced' });
        await db.productImageQueue.delete(item.id);
      });
    } catch {
      await db.productImageQueue.update(item.id, { attemptCount: item.attemptCount + 1, lastAttemptAt: new Date().toISOString() });
      return false;
    }
  }
  return true;
}

export async function flushProductImageDeletes() {
  const configuration = await getImageConfiguration();
  if (!configuration || !navigator.onLine) return;
  const deletions = await db.productImageQueue.where('operation').equals('delete').toArray();
  for (const item of deletions) {
    try {
      const response = await fetch(imageUrl(configuration.apiUrl, configuration.storeId, item.productId, item.revision), {
        method: 'DELETE',
        headers: { authorization: `Bearer ${configuration.token}` },
      });
      if (!response.ok && response.status !== 404) throw new Error(await readableImageError(response));
      await db.productImageQueue.delete(item.id);
    } catch {
      await db.productImageQueue.update(item.id, { attemptCount: item.attemptCount + 1, lastAttemptAt: new Date().toISOString() });
      return;
    }
  }
}

export async function hydrateProductImage(product: Product) {
  if (!product.imageRevision) return null;
  const local = await db.productImages.get(product.id);
  if (local?.revision === product.imageRevision) return local;
  const configuration = await getImageConfiguration();
  if (!configuration || !navigator.onLine) return null;
  const response = await fetch(imageUrl(configuration.apiUrl, configuration.storeId, product.id, product.imageRevision), {
    headers: { authorization: `Bearer ${configuration.token}` },
  });
  if (!response.ok) return null;
  const blob = await response.blob();
  if (!['image/webp', 'image/jpeg'].includes(blob.type) || blob.size > MAX_IMAGE_BYTES) return null;
  const record = {
    productId: product.id,
    revision: product.imageRevision,
    blob,
    contentType: blob.type as 'image/webp' | 'image/jpeg',
    byteLength: blob.size,
    syncStatus: 'synced' as const,
    updatedAt: new Date().toISOString(),
  };
  await db.productImages.put(record);
  window.dispatchEvent(new Event('pos-images-changed'));
  return record;
}

export async function hydrateProductImages(products: Product[]) {
  for (const product of products) {
    if (product.imageRevision) await hydrateProductImage(product);
  }
}

async function getImageConfiguration() {
  const [session, token] = await Promise.all([getSession(), getSessionToken()]);
  return session?.store && token ? { apiUrl: API_DEFAULT, token, storeId: session.store.id } : null;
}

function imageUrl(apiUrl: string, storeId: string, productId: string, revision: string) {
  return `${apiUrl.replace(/\/$/, '')}/v1/stores/${encodeURIComponent(storeId)}/products/${encodeURIComponent(productId)}/images/${encodeURIComponent(revision)}`;
}

async function readableImageError(response: Response) {
  try {
    const body = await response.json() as { message?: string | string[] };
    return Array.isArray(body.message) ? body.message.join(', ') : body.message || `Image request failed (${response.status})`;
  } catch {
    return `Image request failed (${response.status})`;
  }
}
