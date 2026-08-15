'use client';

import type {
  AuthSession,
  AuthSessionResponse,
  BackupSummary,
  CashierLoginRequest,
  CreateStaffRequest,
  OwnerLoginRequest,
  ResetStaffSecretRequest,
  SetupOwnerRequest,
  SetupStatusResponse,
  StaffMember,
  StoreBootstrapResponse,
  StoreCommand,
  StoreCommandRequest,
  StoreCommandResponse,
  StoreSyncResponse,
  SuperadminCreateStoreRequest,
  SuperadminStaffInput,
  SuperadminStoreListResponse,
  SuperadminStoreMutationResponse,
} from '@gma/contracts';
import {
  applyServerSync,
  clearConflictMessage,
  getActiveStoreId,
  getConflictMessage,
  getMutationQueueSummary,
  getOrCreateDeviceId,
  getSession,
  getSessionToken,
  getSyncCursor,
  hasCompletedBootstrap,
  listQueuedCommands,
  removeQueuedCommand,
  replaceStoreSnapshot,
  saveSession,
  setConflictMessage,
  setDeviceName,
  signOutLocally,
  db,
} from './db';
import { flushProductImageDeletes, flushProductImageUploads } from './product-images';

const API_DEFAULT = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';
const MANAGER_ACCESS_DENIED_MESSAGE = 'You do not have access to this action';

export interface SyncState {
  phase: 'synced' | 'offline' | 'syncing' | 'pending' | 'needs_attention';
  pendingCount: number;
  needsAttentionCount: number;
  pendingSaleCount: number;
  needsAttentionSaleCount: number;
  completedCount: number;
  totalCount: number;
}

let syncPromise: Promise<void> | null = null;
let syncRequestedAgain = false;
let activeSyncState: Pick<SyncState, 'completedCount' | 'totalCount'> = { completedCount: 0, totalCount: 0 };
let serverAvailable = true;

export class ApiRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

export function normalizeApiUrl(value = API_DEFAULT) {
  return value.replace(/\/$/, '');
}

export function isManagerAccessDenied(error: unknown) {
  return error instanceof Error && error.message === MANAGER_ACCESS_DENIED_MESSAGE;
}

export function isInvalidSessionError(error: unknown) {
  return error instanceof ApiRequestError && (error.status === 401 || error.status === 403);
}

export async function fetchSetupStatus(apiUrl = API_DEFAULT) {
  return apiRequest<SetupStatusResponse>(normalizeApiUrl(apiUrl), '/v1/auth/setup-status');
}

export async function setupOwner(input: Omit<SetupOwnerRequest, 'deviceId'> & { apiUrl?: string }) {
  const deviceId = await getOrCreateDeviceId();
  await setDeviceName(input.deviceName);
  const response = await apiRequest<AuthSession>(normalizeApiUrl(input.apiUrl), '/v1/auth/setup-owner', {
    method: 'POST',
    body: JSON.stringify({ ...input, deviceId }),
  });
  await saveSession(response);
  if (!response.store) throw new Error('Store setup did not return a store session');
  return bootstrapStore(response.store.id, response.token, normalizeApiUrl(input.apiUrl));
}

export async function loginOwner(input: Omit<OwnerLoginRequest, 'deviceId'> & { apiUrl?: string }) {
  const deviceId = await getOrCreateDeviceId();
  await setDeviceName(input.deviceName);
  const response = await apiRequest<AuthSession>(normalizeApiUrl(input.apiUrl), '/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify({ ...input, deviceId }),
  });
  await saveSession(response);
  if (!response.store) return response;
  return bootstrapStore(response.store.id, response.token, normalizeApiUrl(input.apiUrl));
}

export async function loginCashier(input: Omit<CashierLoginRequest, 'deviceId'> & { apiUrl?: string }) {
  const deviceId = await getOrCreateDeviceId();
  await setDeviceName(input.deviceName);
  const response = await apiRequest<AuthSession>(normalizeApiUrl(input.apiUrl), '/v1/auth/cashier-login', {
    method: 'POST',
    body: JSON.stringify({ ...input, deviceId }),
  });
  await saveSession(response);
  if (!response.store) throw new Error('Cashier login did not return a store session');
  return bootstrapStore(response.store.id, response.token, normalizeApiUrl(input.apiUrl));
}

export async function rehydrateSession(apiUrl = API_DEFAULT) {
  const [session, token] = await Promise.all([getSession(), getSessionToken()]);
  if (!session || !token) return null;
  const response = await apiRequest<AuthSession>(normalizeApiUrl(apiUrl), '/v1/auth/me', {
    headers: { authorization: `Bearer ${token}` },
  });
  await saveSession({ ...response, token });
  if (!response.store) return { ...response, token };
  return bootstrapStore(response.store.id, token, normalizeApiUrl(apiUrl));
}

export async function bootstrapStore(storeId: string, token: string, apiUrl = API_DEFAULT) {
  const [bootstrapped, queue] = await Promise.all([hasCompletedBootstrap(), getMutationQueueSummary()]);
  if (bootstrapped && queue.totalCount > 0) {
    await requestSync(apiUrl);
    const remaining = await getMutationQueueSummary();
    if (remaining.totalCount > 0) {
      const localSession = await getSession();
      if (localSession?.store) return localSession;
    }
  }
  const response = await apiRequest<StoreBootstrapResponse>(normalizeApiUrl(apiUrl), `/v1/stores/${storeId}/bootstrap`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.session.store) throw new Error('Store bootstrap did not return a store session');
  await saveSession(response.session);
  await replaceStoreSnapshot(response.snapshot, response.cursor);
  await clearConflictMessage();
  return response.session;
}

export async function syncStore(apiUrl = API_DEFAULT) {
  const [session, token] = await Promise.all([getSession(), getSessionToken()]);
  if (!session?.store || !token) return null;
  if ((await getMutationQueueSummary()).totalCount > 0) return null;
  const response = await apiRequest<StoreSyncResponse>(normalizeApiUrl(apiUrl), `/v1/stores/${session.store.id}/sync`, {
    headers: { authorization: `Bearer ${token}` },
  });
  await applyServerSync(response);
  return response;
}

export async function logout(apiUrl = API_DEFAULT) {
  const token = await getSessionToken();
  if (token) {
    try {
      await apiRequest(normalizeApiUrl(apiUrl), '/v1/auth/logout', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      });
    } catch {
      // ignore network errors during logout; local session still clears
    }
  }
  await signOutLocally();
}

export async function createCommandRequest(command: StoreCommand): Promise<StoreCommandRequest> {
  return {
    clientCommandId: crypto.randomUUID(),
    baseCursor: await getSyncCursor(),
    command,
  };
}

export async function getSyncState(): Promise<SyncState> {
  const summary = await getMutationQueueSummary();
  const online = typeof navigator === 'undefined' || navigator.onLine;
  const phase = summary.needsAttentionCount > 0
    ? 'needs_attention'
    : syncPromise
      ? 'syncing'
      : summary.pendingCount > 0
        ? (online ? 'pending' : 'offline')
        : online && serverAvailable ? 'synced' : 'offline';
  return { phase, ...summary, ...activeSyncState };
}

export function requestSync(apiUrl = API_DEFAULT) {
  if (syncPromise) {
    syncRequestedAgain = true;
    return syncPromise;
  }
  syncPromise = (async () => {
    do {
      syncRequestedAgain = false;
      try {
        await runSync(apiUrl);
      } catch {
        // Local commands are already durable. A coordinator failure must never
        // surface as an unhandled rejection or make the cashier repeat a sale.
        break;
      }
    } while (syncRequestedAgain);
  })().finally(() => {
    syncPromise = null;
    activeSyncState = { completedCount: 0, totalCount: 0 };
    dispatchSyncStateChanged();
  });
  dispatchSyncStateChanged();
  return syncPromise;
}

export async function flushMutationQueue(apiUrl = API_DEFAULT) {
  await requestSync(apiUrl);
  return null;
}

export async function retryNeedsAttention(apiUrl = API_DEFAULT) {
  await db.mutationQueue.where('status').equals('needs_attention').modify({
    status: 'pending',
    errorMessage: null,
  });
  await clearConflictMessage();
  dispatchSyncStateChanged();
  await requestSync(apiUrl);
}

async function runSync(apiUrl: string) {
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    dispatchSyncStateChanged();
    return;
  }
  const [session, token] = await Promise.all([getSession(), getSessionToken()]);
  if (!session?.store || !token) return;
  const queued = await listQueuedCommands();
  activeSyncState = { completedCount: 0, totalCount: queued.length };
  dispatchSyncStateChanged();
  for (let index = 0; index < queued.length; index += 1) {
    const item = queued[index];
    if (item.status === 'needs_attention') break;
    const attemptedAt = new Date().toISOString();
    await db.mutationQueue.update(item.id, {
      status: 'syncing',
      attemptCount: item.attemptCount + 1,
      lastAttemptAt: attemptedAt,
      errorMessage: null,
    });
    dispatchSyncStateChanged();
    try {
      const response = await apiRequest<StoreCommandResponse>(normalizeApiUrl(apiUrl), `/v1/stores/${session.store.id}/commands`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify(item.request),
      });
      if (response.status === 'conflict') {
        await db.mutationQueue.update(item.id, { status: 'needs_attention', errorMessage: response.message });
        await setConflictMessage(response.message);
        break;
      }
      await removeQueuedCommand(item.id);
      await clearConflictMessage();
      activeSyncState = { completedCount: index + 1, totalCount: queued.length };
      dispatchSyncStateChanged();
    } catch (error) {
      const permanent = error instanceof ApiRequestError && error.status >= 400 && error.status < 500 && error.status !== 401 && error.status !== 408 && error.status !== 429;
      const message = error instanceof Error ? error.message : 'Could not reach the server';
      await db.mutationQueue.update(item.id, { status: permanent ? 'needs_attention' : 'pending', errorMessage: message });
      if (permanent) await setConflictMessage(message);
      break;
    }
  }
  const remaining = await getMutationQueueSummary();
  if (remaining.totalCount > 0) {
    dispatchSyncStateChanged();
    return;
  }
  try {
    await syncStore(apiUrl);
  } catch {
    dispatchSyncStateChanged();
    return;
  }
  await flushProductImageUploads();
  await flushProductImageDeletes();
  dispatchSyncStateChanged();
}

function dispatchSyncStateChanged() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('pos-sync-state-changed'));
}

export async function listStaff(apiUrl = API_DEFAULT) {
  const session = await requireStoreSession();
  return apiAuthed<{ staff: StaffMember[] }>(`/v1/stores/${session.store.id}/staff`, {}, apiUrl).then((value) => value.staff);
}

export async function createStaff(input: CreateStaffRequest, apiUrl = API_DEFAULT) {
  const session = await requireStoreSession();
  return apiAuthed<{ staff: StaffMember }>(`/v1/stores/${session.store.id}/staff`, {
    method: 'POST',
    body: JSON.stringify(input),
  }, apiUrl).then((value) => value.staff);
}

export async function disableStaff(userId: string, apiUrl = API_DEFAULT) {
  const session = await requireStoreSession();
  return apiAuthed<{ staff: StaffMember }>(`/v1/stores/${session.store.id}/staff/${userId}/disable`, {
    method: 'PATCH',
  }, apiUrl).then((value) => value.staff);
}

export async function resetStaffSecret(userId: string, input: ResetStaffSecretRequest, apiUrl = API_DEFAULT) {
  const session = await requireStoreSession();
  return apiAuthed<{ staff: StaffMember }>(`/v1/stores/${session.store.id}/staff/${userId}/reset-secret`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  }, apiUrl).then((value) => value.staff);
}

export async function getBackupStatus(apiUrl = API_DEFAULT) {
  const session = await requireStoreSession();
  return apiAuthed<BackupSummary>(`/v1/stores/${session.store.id}/backups/status`, {}, apiUrl);
}

export async function createServerBackup(apiUrl = API_DEFAULT) {
  const session = await requireStoreSession();
  return apiAuthed<BackupSummary>(`/v1/stores/${session.store.id}/backups`, { method: 'POST' }, apiUrl);
}

export async function listSuperadminStores(apiUrl = API_DEFAULT) {
  return apiAuthed<SuperadminStoreListResponse>('/v1/superadmin/stores', {}, apiUrl).then((value) => value.stores);
}

export async function createSuperadminStore(input: SuperadminCreateStoreRequest, apiUrl = API_DEFAULT) {
  return apiAuthed<SuperadminStoreMutationResponse>('/v1/superadmin/stores', {
    method: 'POST',
    body: JSON.stringify(input),
  }, apiUrl);
}

export async function createSuperadminStoreStaff(storeId: string, input: SuperadminStaffInput, apiUrl = API_DEFAULT) {
  return apiAuthed<SuperadminStoreMutationResponse>(`/v1/superadmin/stores/${storeId}/staff`, {
    method: 'POST',
    body: JSON.stringify(input),
  }, apiUrl);
}

export async function getCachedConflictMessage() {
  return getConflictMessage();
}

async function requireSession() {
  const session = await getSession();
  if (!session) throw new Error('You must sign in first');
  return session;
}

async function requireStoreSession() {
  const session = await requireSession();
  if (!session.store) throw new Error('Choose a store first');
  return session;
}

async function apiAuthed<T>(path: string, init: RequestInit = {}, apiUrl = API_DEFAULT) {
  const token = await getSessionToken();
  if (!token) throw new Error('You must sign in first');
  return apiRequest<T>(normalizeApiUrl(apiUrl), path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init.headers || {}),
      authorization: `Bearer ${token}`,
    },
  });
}

async function apiRequest<T = unknown>(baseUrl: string, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers || {});
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, { ...init, headers });
    serverAvailable = true;
  } catch (error) {
    serverAvailable = false;
    dispatchSyncStateChanged();
    throw error;
  }
  if (!response.ok) throw new ApiRequestError(await readableApiError(response), response.status);
  if (response.status === 204) return undefined as T;
  return await response.json() as T;
}

async function readableApiError(response: Response) {
  try {
    const body = await response.json() as { message?: string | string[] };
    return Array.isArray(body.message) ? body.message.join(', ') : body.message || `Request failed (${response.status})`;
  } catch {
    return `Request failed (${response.status})`;
  }
}
