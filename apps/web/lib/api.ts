'use client';

import type {
  AuthSession,
  ActivityLogFilters,
  ActivityLogListResponse,
  AuthSessionResponse,
  BackupSummary,
  CashierLoginRequest,
  CreateStaffRequest,
  DeviceEnrollmentChallenge,
  DeviceEnrollmentDecisionResponse,
  ManagerActionConfirmationResponse,
  OwnerLoginRequest,
  ResetStaffSecretRequest,
  SetupOwnerRequest,
  SetupStatusResponse,
  StaffMember,
  StoreBootstrapResponse,
  StoreCommand,
  StoreCommandRequest,
  StoreCommandResponse,
  StoreDeltaSyncResponse,
  StoreSyncResponse,
  SuperadminCreateStoreRequest,
  SuperadminResetStaffSecretRequest,
  SuperadminStaffInput,
  SuperadminStaffStatusRequest,
  SuperadminStoreDetailsResponse,
  SuperadminStoreListResponse,
  SuperadminStoreMutationResponse,
  SuperadminStoreStatusRequest,
} from '@gma/contracts';
import {
  applyServerSync,
  applyServerDelta,
  cacheActivityLogs,
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
import { hydrateQrPhImage } from './qr-ph';

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
  constructor(message: string, readonly status: number, readonly body?: unknown) {
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

export async function fetchSetupStatus(apiUrl = API_DEFAULT, signal?: AbortSignal) {
  return apiRequest<SetupStatusResponse>(normalizeApiUrl(apiUrl), '/v1/auth/setup-status', { signal, cache: 'no-store' });
}

export async function setupOwner(input: Omit<SetupOwnerRequest, 'deviceId'> & { apiUrl?: string }) {
  await assertAuthenticationCanProceed();
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
  await assertAuthenticationCanProceed();
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
  await assertAuthenticationCanProceed();
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
  await hydrateQrPhImage(apiUrl).catch(() => undefined);
  await clearConflictMessage();
  return response.session;
}

export async function syncStore(apiUrl = API_DEFAULT) {
  const [session, token] = await Promise.all([getSession(), getSessionToken()]);
  if (!session?.store || !token) return null;
  if ((await getMutationQueueSummary()).totalCount > 0) return null;
  let cursor = await getSyncCursor();
  let response: StoreDeltaSyncResponse | null = null;
  for (let page = 0; page < 100; page += 1) {
    try {
      response = await apiRequest<StoreDeltaSyncResponse>(normalizeApiUrl(apiUrl), `/v1/stores/${session.store.id}/sync?cursor=${cursor}`, {
        headers: { authorization: `Bearer ${token}`, 'x-pos-sync-version': '2' },
      });
    } catch (error) {
      const body = error instanceof ApiRequestError && error.body && typeof error.body === 'object'
        ? error.body as Record<string, unknown>
        : null;
      if (error instanceof ApiRequestError && error.status === 409 && body?.code === 'full_resync_required') {
        const bootstrap = await apiRequest<StoreBootstrapResponse>(normalizeApiUrl(apiUrl), `/v1/stores/${session.store.id}/bootstrap`, {
          headers: { authorization: `Bearer ${token}` },
        });
        await replaceStoreSnapshot(bootstrap.snapshot, bootstrap.cursor);
        return {
          cursor: bootstrap.cursor, changes: [], tombstones: [], hasMore: false,
          fullSnapshot: bootstrap.snapshot,
          historyWindowStart: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(),
        };
      }
      throw error;
    }
    if (response.fullSnapshot) await applyServerSync({ cursor: response.cursor, snapshot: response.fullSnapshot });
    else await applyServerDelta(response);
    if (!response.hasMore) break;
    if (response.cursor <= cursor) throw new Error('Server sync cursor did not advance');
    cursor = response.cursor;
  }
  if (response?.hasMore) throw new Error('Server sync exceeded the page safety limit');
  await hydrateQrPhImage(apiUrl).catch(() => undefined);
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
  if (typeof navigator !== 'undefined') {
    navigator.serviceWorker?.controller?.postMessage({ type: 'PURGE_PRIVATE_CACHES' });
  }
}

export async function createCommandRequest(command: StoreCommand): Promise<StoreCommandRequest> {
  const actorProof = await getSessionToken();
  return {
    clientCommandId: crypto.randomUUID(),
    baseCursor: await getSyncCursor(),
    occurredAt: new Date().toISOString(),
    ...(actorProof ? { actorProof } : {}),
    command,
  };
}

export async function runManagerApprovedCommand(command: StoreCommand, password: string, apiUrl = API_DEFAULT) {
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    throw new Error('Connect to the internet to verify your password and adjust stock.');
  }
  await requestSync(apiUrl);
  const queue = await getMutationQueueSummary();
  if (queue.totalCount > 0) {
    throw new Error('Finish syncing pending work before adjusting stock.');
  }
  const session = await requireStoreSession();
  const request = await createCommandRequest(command);
  const confirmation = await apiAuthed<ManagerActionConfirmationResponse>('/v1/auth/confirm-manager-action', {
    method: 'POST',
    body: JSON.stringify({ action: 'adjust_stock', clientCommandId: request.clientCommandId, password }),
  }, apiUrl);
  const response = await apiAuthed<StoreCommandResponse>(`/v1/stores/${session.store.id}/commands`, {
    method: 'POST',
    body: JSON.stringify({ ...request, managerApprovalProof: confirmation.proof }),
  }, apiUrl);
  if (response.snapshot) await applyServerSync({ cursor: response.cursor, snapshot: response.snapshot });
  else if (response.status === 'applied') await syncStore(apiUrl);
  if (response.status === 'conflict') throw new Error(response.message);
  dispatchCommandsSynced();
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('pos-data-changed', { detail: { source: 'server' } }));
    window.dispatchEvent(new Event('pos-sync-state-changed'));
  }
  return response;
}

export async function listActivityLogs(filters: ActivityLogFilters = {}, apiUrl = API_DEFAULT) {
  const session = await requireStoreSession();
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== null && value !== '') query.set(key, String(value));
  }
  const suffix = query.size ? `?${query.toString()}` : '';
  const response = await apiAuthed<ActivityLogListResponse>(`/v1/stores/${session.store.id}/activity-logs${suffix}`, {}, apiUrl);
  await cacheActivityLogs(response.activity);
  return response;
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
  await repairInvalidProductUnitCommands();
  await db.mutationQueue.where('status').equals('needs_attention').modify({
    status: 'pending',
    errorMessage: null,
    nextAttemptAt: null,
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
  let completedCommands = 0;
  activeSyncState = { completedCount: 0, totalCount: queued.length };
  dispatchSyncStateChanged();
  for (let index = 0; index < queued.length; index += 1) {
    const item = queued[index];
    if (item.status === 'needs_attention') break;
    if (item.nextAttemptAt && Date.parse(item.nextAttemptAt) > Date.now()) break;
    const attemptedAt = new Date().toISOString();
    await db.mutationQueue.update(item.id, {
      status: 'syncing',
      attemptCount: item.attemptCount + 1,
      lastAttemptAt: attemptedAt,
      nextAttemptAt: null,
      errorMessage: null,
    });
    dispatchSyncStateChanged();
    try {
      const response = await apiRequest<StoreCommandResponse>(normalizeApiUrl(apiUrl), `/v1/stores/${session.store.id}/commands`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'x-pos-sync-version': '2', 'x-command-id': item.id },
        body: JSON.stringify(item.request),
      });
      if (response.status === 'conflict') {
        await db.mutationQueue.update(item.id, { status: 'needs_attention', errorMessage: response.message });
        await setConflictMessage(response.message);
        break;
      }
      await removeQueuedCommand(item.id);
      completedCommands += 1;
      await clearConflictMessage();
      activeSyncState = { completedCount: index + 1, totalCount: queued.length };
      dispatchSyncStateChanged();
    } catch (error) {
      const permanent = error instanceof ApiRequestError && error.status >= 400 && error.status < 500 && error.status !== 401 && error.status !== 408 && error.status !== 429;
      const message = error instanceof Error ? error.message : 'Could not reach the server';
      const retryDelay = Math.min(5 * 60_000, 1_000 * (2 ** Math.min(item.attemptCount, 8)));
      const jitter = Math.floor(Math.random() * Math.max(250, retryDelay * 0.25));
      await db.mutationQueue.update(item.id, {
        status: permanent ? 'needs_attention' : 'pending',
        errorMessage: message,
        nextAttemptAt: permanent ? null : new Date(Date.now() + retryDelay + jitter).toISOString(),
      });
      if (permanent) await setConflictMessage(message);
      break;
    }
  }
  if (completedCommands > 0) dispatchCommandsSynced();
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

function dispatchCommandsSynced() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('pos-commands-synced'));
}

function setServerAvailable(available: boolean) {
  if (serverAvailable === available) return;
  serverAvailable = available;
  dispatchSyncStateChanged();
}

async function repairInvalidProductUnitCommands() {
  const items = await db.mutationQueue.where('status').equals('needs_attention').toArray();
  for (const item of items) {
    if (!item.errorMessage?.includes('productUnitId') || !item.errorMessage.includes('Invalid UUID')) continue;
    const command = item.request.command;
    if (!('productUnitId' in command.payload) || typeof command.payload.productUnitId !== 'string' || isUuid(command.payload.productUnitId)) continue;
    const [product, staleUnit] = await Promise.all([
      db.products.get(command.payload.productId),
      db.productUnits.get(command.payload.productUnitId),
    ]);
    if (!product || !staleUnit) continue;
    const matchingUnit = await db.productUnits
      .where('productId')
      .equals(product.id)
      .filter((unit) => isUuid(unit.id) && unit.isActive && unit.canRestock
        && unit.multiplierBaseUnits === staleUnit.multiplierBaseUnits
        && unit.quantityStep === staleUnit.quantityStep
        && unit.name === staleUnit.name)
      .first();
    if (matchingUnit) {
      await db.mutationQueue.update(item.id, {
        request: {
          ...item.request,
          command: {
            ...command,
            payload: { ...command.payload, productUnitId: matchingUnit.id },
          } as StoreCommand,
        },
      });
      continue;
    }
    if (command.type === 'receiveStock') {
      const displayQuantity = command.payload.inputQuantity * staleUnit.multiplierBaseUnits / legacyDisplayMultiplier(product.unit);
      if (!Number.isFinite(displayQuantity) || displayQuantity <= 0) continue;
      await db.mutationQueue.update(item.id, {
        request: {
          ...item.request,
          command: {
            type: 'restockProduct',
            payload: {
              productId: product.id,
              mode: 'add',
              quantity: normalizeQuantity(displayQuantity),
              note: command.payload.note,
              expectedVersion: Math.max(1, product.recordVersion - 1),
            },
          },
        },
      });
    }
  }
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function legacyDisplayMultiplier(unit: string) {
  const normalized = unit.trim().toLowerCase();
  return ['kg', 'kilogram', 'liter', 'litre'].includes(normalized) ? 1000 : 1;
}

function normalizeQuantity(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export async function listStaff(apiUrl = API_DEFAULT) {
  const session = await requireStoreSession();
  return apiAuthed<{ staff: StaffMember[] }>(`/v1/stores/${session.store.id}/staff`, {}, apiUrl).then((value) => value.staff);
}

export async function listDeviceEnrollments(apiUrl = API_DEFAULT) {
  return apiAuthed<{ challenges: DeviceEnrollmentChallenge[] }>('/v1/auth/device-enrollments', {}, apiUrl)
    .then((value) => value.challenges);
}

export async function decideDeviceEnrollment(challengeId: string, approve: boolean, apiUrl = API_DEFAULT) {
  return apiAuthed<DeviceEnrollmentDecisionResponse>(`/v1/auth/device-enrollments/${encodeURIComponent(challengeId)}/decision`, {
    method: 'POST',
    body: JSON.stringify({ approve }),
  }, apiUrl);
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

export async function getSuperadminStoreDetails(storeId: string, apiUrl = API_DEFAULT) {
  return apiAuthed<SuperadminStoreDetailsResponse>(`/v1/superadmin/stores/${storeId}`, {}, apiUrl);
}

export async function updateSuperadminStoreStatus(storeId: string, input: SuperadminStoreStatusRequest, apiUrl = API_DEFAULT) {
  return apiAuthed<SuperadminStoreDetailsResponse>(`/v1/superadmin/stores/${storeId}/status`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  }, apiUrl);
}

export async function updateSuperadminStaffStatus(storeId: string, userId: string, input: SuperadminStaffStatusRequest, apiUrl = API_DEFAULT) {
  return apiAuthed<SuperadminStoreDetailsResponse>(`/v1/superadmin/stores/${storeId}/staff/${userId}/status`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  }, apiUrl);
}

export async function resetSuperadminStaffSecret(storeId: string, userId: string, input: SuperadminResetStaffSecretRequest, apiUrl = API_DEFAULT) {
  return apiAuthed<SuperadminStoreDetailsResponse>(`/v1/superadmin/stores/${storeId}/staff/${userId}/reset-secret`, {
    method: 'PATCH',
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

async function assertAuthenticationCanProceed() {
  const activeStoreId = await getActiveStoreId();
  if (!activeStoreId) return;
  const [commands, imageOperations] = await Promise.all([
    db.mutationQueue.where('storeId').equals(activeStoreId).count(),
    db.productImageQueue.where('storeId').equals(activeStoreId).count(),
  ]);
  if (commands + imageOperations > 0) {
    throw new Error('This device has unresolved offline work. Reconnect and finish syncing it before signing into another store.');
  }
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

async function apiRequest<T = unknown>(baseUrl: string, path: string, init: RequestInit = {}, canRefresh = true) {
  const headers = new Headers(init.headers || {});
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, { ...init, headers, credentials: 'include' });
    setServerAvailable(true);
  } catch (error) {
    setServerAvailable(false);
    throw error;
  }
  if (canRefresh && response.status === 401 && path !== '/v1/auth/refresh' && headers.has('authorization')) {
    const refreshed = await refreshAccessToken(baseUrl);
    if (refreshed) {
      headers.set('authorization', `Bearer ${refreshed.token}`);
      return apiRequest<T>(baseUrl, path, { ...init, headers }, false);
    }
  }
  if (!response.ok) {
    const body = await readableApiErrorBody(response);
    throw new ApiRequestError(describeApiError(body, response.status), response.status, body);
  }
  if (response.status === 204) return undefined as T;
  return await response.json() as T;
}

let refreshPromise: Promise<AuthSession | null> | null = null;

async function refreshAccessToken(baseUrl: string) {
  refreshPromise ??= (async () => {
    try {
      const response = await fetch(`${baseUrl}/v1/auth/refresh`, { method: 'POST', credentials: 'include' });
      if (!response.ok) return null;
      const session = await response.json() as AuthSession;
      await saveSession(session);
      return session;
    } catch {
      return null;
    } finally {
      refreshPromise = null;
    }
  })();
  return refreshPromise;
}

async function readableApiErrorBody(response: Response) {
  try {
    return await response.json() as unknown;
  } catch {
    return null;
  }
}

async function readableApiError(response: Response) {
  return describeApiError(await readableApiErrorBody(response), response.status);
}

function describeApiError(body: unknown, status: number) {
  const fallback = `Request failed (${status})`;
  if (!body || typeof body !== 'object') return fallback;
  const record = body as Record<string, unknown>;
  const message = normalizeApiMessage(record.message);
  const details = validationDetails(record.issues ?? record.errors ?? record.message);
  if (details.length) return `${message ?? fallback}: ${details.join('; ')}`;
  if (message) return message;
  if (typeof record.error === 'string' && record.error.trim()) return `${record.error.trim()} (${status})`;
  return fallback;
}

function normalizeApiMessage(value: unknown) {
  if (typeof value === 'string') return value.trim() || null;
  if (Array.isArray(value)) {
    const messages = value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
    return messages.length ? messages.join(', ') : null;
  }
  return null;
}

function validationDetails(value: unknown): string[] {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const issue = item as { path?: unknown; message?: unknown };
      if (typeof issue.message !== 'string') return [];
      const path = Array.isArray(issue.path) ? issue.path.map(String).join('.') : '';
      return path ? `${path}: ${issue.message}` : issue.message;
    });
  }
  const record = value as Record<string, unknown>;
  const details: string[] = [];
  const formErrors = record.formErrors;
  if (Array.isArray(formErrors)) {
    details.push(...formErrors.filter((item): item is string => typeof item === 'string'));
  }
  const fieldErrors = record.fieldErrors;
  if (fieldErrors && typeof fieldErrors === 'object') {
    for (const [field, messages] of Object.entries(fieldErrors as Record<string, unknown>)) {
      if (Array.isArray(messages)) {
        const text = messages.filter((item): item is string => typeof item === 'string').join(', ');
        if (text) details.push(`${field}: ${text}`);
      }
    }
  }
  return details;
}
