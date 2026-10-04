'use client';

import type { QrPhPaymentSettings } from '@gma/contracts';
import { db, getSession, getSessionToken, type QrPhImageRecord } from './db';

const API_DEFAULT = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';
const ALLOWED_TYPES = new Set<QrPhPaymentSettings['contentType']>(['image/png', 'image/webp', 'image/jpeg']);
const MAX_BYTES = 2 * 1024 * 1024;

export async function getCachedQrPhImage() {
  const session = await getSession();
  if (!session?.store) return null;
  const settings = await db.paymentSettings.get(session.store.id);
  const image = await db.qrPhImages.get('qrph');
  return settings && image?.storeId === session.store.id && image.revision === settings.imageRevision ? { settings, image } : null;
}

export async function hydrateQrPhImage(apiUrl = API_DEFAULT) {
  const [session, token] = await Promise.all([getSession(), getSessionToken()]);
  if (!session?.store || !token) return null;
  const settings = await db.paymentSettings.get(session.store.id);
  if (!settings) {
    await db.qrPhImages.delete('qrph');
    return null;
  }
  const cached = await db.qrPhImages.get('qrph');
  if (cached?.storeId === session.store.id && cached.revision === settings.imageRevision) return cached;
  const response = await fetch(qrUrl(apiUrl, session.store.id, settings.imageRevision), {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) return null;
  const blob = await response.blob();
  if (!ALLOWED_TYPES.has(blob.type as QrPhPaymentSettings['contentType']) || blob.size > MAX_BYTES) return null;
  const record: QrPhImageRecord = {
    key: 'qrph',
    storeId: session.store.id,
    revision: settings.imageRevision,
    blob,
    contentType: blob.type as QrPhPaymentSettings['contentType'],
    byteLength: blob.size,
    updatedAt: settings.updatedAt,
  };
  await db.qrPhImages.put(record);
  window.dispatchEvent(new Event('pos-qrph-changed'));
  return record;
}

export async function uploadQrPhImage(file: File, apiUrl = API_DEFAULT) {
  const [session, token] = await Promise.all([getSession(), getSessionToken()]);
  if (!session?.store || !token) throw new Error('Sign in before configuring QR Ph');
  if (!ALLOWED_TYPES.has(file.type as QrPhPaymentSettings['contentType'])) throw new Error('Choose a PNG, WebP, or JPEG QR image');
  if (!file.size || file.size > MAX_BYTES) throw new Error('QR Ph image must be 2 MB or smaller');
  const revision = crypto.randomUUID();
  const response = await fetch(qrUrl(apiUrl, session.store.id, revision), {
    method: 'PUT',
    headers: { authorization: `Bearer ${token}`, 'content-type': file.type },
    body: file,
  });
  if (!response.ok) throw new Error(await responseMessage(response, 'Could not upload QR Ph image'));
  const settings = await response.json() as QrPhPaymentSettings;
  await db.transaction('rw', [db.paymentSettings, db.qrPhImages], async () => {
    await db.paymentSettings.put(settings);
    await db.qrPhImages.put({
      key: 'qrph', storeId: session.store!.id, revision, blob: file, contentType: settings.contentType,
      byteLength: file.size, updatedAt: settings.updatedAt,
    });
  });
  window.dispatchEvent(new Event('pos-data-changed'));
  window.dispatchEvent(new Event('pos-qrph-changed'));
  return settings;
}

export async function deleteQrPhImage(apiUrl = API_DEFAULT) {
  const [session, token] = await Promise.all([getSession(), getSessionToken()]);
  if (!session?.store || !token) throw new Error('Sign in before configuring QR Ph');
  const settings = await db.paymentSettings.get(session.store.id);
  if (!settings) return;
  const response = await fetch(qrUrl(apiUrl, session.store.id, settings.imageRevision), {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(await responseMessage(response, 'Could not remove QR Ph image'));
  await db.transaction('rw', [db.paymentSettings, db.qrPhImages], async () => {
    await db.paymentSettings.delete(session.store!.id);
    await db.qrPhImages.delete('qrph');
  });
  window.dispatchEvent(new Event('pos-data-changed'));
  window.dispatchEvent(new Event('pos-qrph-changed'));
}

function qrUrl(apiUrl: string, storeId: string, revision: string) {
  return `${apiUrl.replace(/\/$/, '')}/v1/stores/${encodeURIComponent(storeId)}/payment-settings/qrph/${encodeURIComponent(revision)}`;
}

async function responseMessage(response: Response, fallback: string) {
  try {
    const body = await response.json() as { message?: string };
    return body.message || fallback;
  } catch {
    return fallback;
  }
}
