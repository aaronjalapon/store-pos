'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ActivityCategory, ActivityLog, ActivityLogFilters, StoreAuthSession, StoreCommand } from '@gma/contracts';
import { activityCategories } from '@gma/contracts';
import { Activity, AlertTriangle, ChevronLeft, Clock3, MonitorSmartphone, RefreshCw, Search, UserRound } from 'lucide-react';
import { getCachedActivityLogs, listQueuedCommands, type MutationQueueItem } from '../lib/db';
import { listActivityLogs } from '../lib/api';
import { activityStatusLabels, buildActivityPresentation, formatActivityRole, type ActivityDetailItem } from '../lib/activity-log-presentation';

const categoryLabels: Record<ActivityCategory, string> = {
  auth: 'Sign-ins',
  sales: 'Sales',
  products: 'Products',
  inventory: 'Inventory',
  customers: 'Customers',
  utang: 'Utang',
  expenses: 'Expenses',
  staff: 'Staff & access',
  backups: 'Backups',
  data: 'Data',
  store: 'Store',
};

interface ActivityFiltersState {
  category: '' | ActivityCategory;
  actorUserId: string;
  role: '' | 'owner' | 'admin' | 'cashier' | 'superadmin';
  from: string;
  to: string;
  q: string;
}

const emptyFilters: ActivityFiltersState = { category: '', actorUserId: '', role: '', from: '', to: '', q: '' };

export function ActivityLogPanel({ session, onClose }: { session: StoreAuthSession; onClose: () => void }) {
  const [confirmed, setConfirmed] = useState<ActivityLog[]>([]);
  const [pending, setPending] = useState<ActivityLog[]>([]);
  const [filters, setFilters] = useState<ActivityFiltersState>(emptyFilters);
  const [queryDraft, setQueryDraft] = useState('');
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [cachedMode, setCachedMode] = useState(false);
  const loadRef = useRef<(append?: boolean, quiet?: boolean) => Promise<void>>(async () => {});

  const requestFilters = useMemo<ActivityLogFilters>(() => ({
    ...(filters.category ? { category: filters.category } : {}),
    ...(filters.actorUserId ? { actorUserId: filters.actorUserId } : {}),
    ...(filters.role ? { role: filters.role } : {}),
    ...(filters.from ? { from: `${filters.from}T00:00:00+08:00` } : {}),
    ...(filters.to ? { to: `${filters.to}T23:59:59.999+08:00` } : {}),
    ...(filters.q ? { q: filters.q } : {}),
    limit: 50,
  }), [filters]);

  useEffect(() => {
    let active = true;
    let inFlight: Promise<void> | null = null;
    let cursor: string | null = null;
    let rows: ActivityLog[] = [];
    let hasLoaded = false;
    let hasOlderPages = false;

    const refreshPending = async () => {
      const items = await listQueuedCommands();
      if (active) setPending(items.map((item) => pendingActivity(item, session)));
    };
    const showCached = async (message: string) => {
      // Preserve already-loaded pages and their DOM nodes during failed retries.
      if (!hasLoaded) {
        const cached = await getCachedActivityLogs(session.store.id);
        if (!active) return;
        rows = cached.filter((item) => matchesFilters(item, filters));
        hasLoaded = true;
        setConfirmed(rows);
      }
      if (active) {
        setCachedMode(true);
        setError(message);
      }
    };
    const load = (append = false, quiet = false): Promise<void> => {
      if (!active) return Promise.resolve();
      if (inFlight) return inFlight;
      if (!quiet) setBusy(true);
      inFlight = (async () => {
        try {
          await refreshPending();
          if (!active) return;
          if (!navigator.onLine) {
            await showCached('Offline · showing cached and pending activity.');
            return;
          }
          const response = await listActivityLogs({ ...requestFilters, ...(append && cursor ? { cursor } : {}) });
          if (!active) return;
          rows = append || (quiet && hasOlderPages)
            ? dedupeActivity([...rows, ...response.activity])
            : response.activity;
          hasLoaded = true;
          if (append) hasOlderPages = true;
          else if (!quiet) hasOlderPages = false;
          if (append || !quiet || !hasOlderPages) {
            cursor = response.nextCursor;
            setNextCursor(cursor);
          }
          setConfirmed(rows);
          setCachedMode(false);
          setError('');
        } catch (caught) {
          if (!active) return;
          const message = !navigator.onLine
            ? 'Offline · showing cached and pending activity.'
            : caught instanceof TypeError
              ? 'Cannot reach the server · showing cached and pending activity'
              : caught instanceof Error ? caught.message : 'Could not load activity.';
          await showCached(message);
        } finally {
          inFlight = null;
          if (active) setBusy(false);
        }
      })();
      return inFlight;
    };
    loadRef.current = load;
    setConfirmed([]);
    setNextCursor(null);
    void load();
    const timer = window.setInterval(() => { void load(false, true); }, 30_000);
    const pendingChanged = () => { void refreshPending().catch(() => undefined); };
    const confirmedChanged = () => { void load(false, true); };
    window.addEventListener('pos-sync-state-changed', pendingChanged);
    window.addEventListener('pos-commands-synced', confirmedChanged);
    window.addEventListener('online', confirmedChanged);
    window.addEventListener('offline', confirmedChanged);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener('pos-sync-state-changed', pendingChanged);
      window.removeEventListener('pos-commands-synced', confirmedChanged);
      window.removeEventListener('online', confirmedChanged);
      window.removeEventListener('offline', confirmedChanged);
    };
  }, [filters, requestFilters, session]);

  const confirmedCommandIds = useMemo(() => new Set(confirmed.map((item) => item.clientCommandId).filter(Boolean)), [confirmed]);
  const visiblePending = pending.filter((item) => !confirmedCommandIds.has(item.clientCommandId) && matchesFilters(item, filters));
  const activity = [...visiblePending, ...confirmed].sort((left, right) => right.occurredAt.localeCompare(left.occurredAt));
  const actors = useMemo(() => {
    const map = new Map<string, ActivityLog['actor']>();
    [...pending, ...confirmed].forEach((item) => { if (item.actor.userId) map.set(item.actor.userId, item.actor); });
    return [...map.values()].sort((left, right) => left.displayName.localeCompare(right.displayName));
  }, [confirmed, pending]);

  return <section className="page-panel activity-page">
    <div className="page-header activity-header">
      <div><p className="eyebrow">STORE OVERSIGHT</p><h1>Activity Log</h1><p>Successful store actions, the people behind them, and offline work waiting to sync.</p></div>
      <div className="page-actions">
        <button className="secondary-button" onClick={onClose}><ChevronLeft /> Back to More</button>
        <button className="primary-button" disabled={busy} onClick={() => void loadRef.current(false)}><RefreshCw /> {busy ? 'Refreshing…' : 'Refresh'}</button>
      </div>
    </div>

    <form className="activity-filters" onSubmit={(event) => { event.preventDefault(); setFilters((current) => ({ ...current, q: queryDraft.trim() })); }}>
      <label className="activity-search"><Search /><input aria-label="Search activity" placeholder="Search actions or people…" value={queryDraft} onChange={(event) => setQueryDraft(event.target.value)} /></label>
      <label><span>Category</span><select aria-label="Activity category" value={filters.category} onChange={(event) => setFilters((current) => ({ ...current, category: event.target.value as ActivityFiltersState['category'] }))}><option value="">All categories</option>{activityCategories.map((category) => <option value={category} key={category}>{categoryLabels[category]}</option>)}</select></label>
      <label><span>User</span><select aria-label="Activity user" value={filters.actorUserId} onChange={(event) => setFilters((current) => ({ ...current, actorUserId: event.target.value }))}><option value="">All users</option>{actors.map((actor) => <option value={actor.userId} key={actor.userId}>{actor.displayName}</option>)}</select></label>
      <label><span>Role</span><select aria-label="Activity role" value={filters.role} onChange={(event) => setFilters((current) => ({ ...current, role: event.target.value as ActivityFiltersState['role'] }))}><option value="">All roles</option><option value="owner">Owner</option><option value="admin">Admin</option><option value="cashier">Cashier</option><option value="superadmin">Superadmin</option></select></label>
      <label><span>From</span><input aria-label="Activity from date" type="date" value={filters.from} onChange={(event) => setFilters((current) => ({ ...current, from: event.target.value }))} /></label>
      <label><span>To</span><input aria-label="Activity to date" type="date" value={filters.to} onChange={(event) => setFilters((current) => ({ ...current, to: event.target.value }))} /></label>
      <button className="secondary-button" type="submit">Apply search</button>
      <button className="secondary-button" type="button" onClick={() => { setFilters(emptyFilters); setQueryDraft(''); }}>Clear</button>
    </form>

    {error && <p className="activity-notice"><AlertTriangle /> {error}</p>}
    <div className="activity-list" aria-live="polite">
      {activity.map((item) => <ActivityRow item={item} key={item.id} />)}
      {!activity.length && !busy && <div className="empty-cart compact-empty"><Activity /><strong>No activity found</strong><p>Actions will appear here after they are completed.</p></div>}
    </div>
    {nextCursor && <button className="secondary-button activity-load-more" disabled={busy || cachedMode} onClick={() => void loadRef.current(true)}>Load more</button>}
  </section>;
}

function ActivityRow({ item }: { item: ActivityLog }) {
  const presentation = buildActivityPresentation(item);
  const hasBusinessDetails = presentation.details.length > 0 || presentation.changes.length > 0;
  return <article className={`activity-row ${item.status}`}>
    <div className="activity-icon" aria-hidden="true">{item.status === 'confirmed' ? <Activity /> : item.status === 'needs_attention' ? <AlertTriangle /> : <Clock3 />}</div>
    <div className="activity-copy">
      <div className="activity-title">
        <strong>{item.summary}</strong>
        <div className="activity-badges"><span className="activity-category">{categoryLabels[item.category]}</span><span className={`activity-status ${item.status}`}>{activityStatusLabels[item.status]}</span></div>
      </div>
      <div className="activity-meta">
        <span className="activity-person"><UserRound aria-hidden="true" /><strong>{item.actor.displayName}</strong><b className={`role-badge ${item.actor.role}`}>{formatActivityRole(item.actor.role)}</b></span>
        <span><Clock3 aria-hidden="true" /> {formatActivityTime(item.occurredAt)}</span>
        {item.deviceName && <span><MonitorSmartphone aria-hidden="true" /> {item.deviceName}</span>}
      </div>
      {item.submittedBy && <small className="activity-delegation">Submitted for sync by {item.submittedBy.displayName} ({formatActivityRole(item.submittedBy.role)}) on behalf of {item.actor.displayName}.</small>}
      {item.errorMessage && <div className="activity-error" role="alert"><strong>Why it needs attention</strong><span>{item.errorMessage}</span></div>}
      {hasBusinessDetails && <details className="activity-details"><summary>See activity details</summary><div className="activity-detail-panel">
        {presentation.details.length > 0 && <DetailList title="What happened" items={presentation.details} />}
        {presentation.changes.length > 0 && <section className="activity-detail-section"><h3>Changes</h3><div className="activity-change-list">{presentation.changes.map((change) => <div className="activity-change" key={change.label}><strong>{change.label}</strong><span><small>Before</small>{change.before}</span><span aria-hidden="true">→</span><span><small>After</small>{change.after}</span></div>)}</div></section>}
      </div></details>}
      {presentation.technical.length > 0 && <details className="activity-technical"><summary>Technical information</summary><div className="activity-detail-panel"><DetailList title="Support details" items={presentation.technical} technical /></div></details>}
    </div>
  </article>;
}

function DetailList({ title, items, technical = false }: { title: string; items: ActivityDetailItem[]; technical?: boolean }) {
  return <section className="activity-detail-section"><h3>{title}</h3><dl className={technical ? 'activity-detail-grid technical' : 'activity-detail-grid'}>{items.map((detail) => <div key={`${detail.label}-${detail.value}`}><dt>{detail.label}</dt><dd>{detail.value}</dd></div>)}</dl></section>;
}

function pendingActivity(item: MutationQueueItem, session: StoreAuthSession): ActivityLog {
  const description = describePendingCommand(item.request.command);
  return {
    id: `pending-${item.id}`,
    storeId: session.store.id,
    actor: item.actor ?? { userId: session.user.id, displayName: session.user.displayName, role: session.user.role },
    submittedBy: null,
    deviceId: session.device.id,
    deviceName: item.deviceName ?? session.device.name,
    category: description.category,
    action: description.action,
    entityType: description.entityType,
    entityId: description.entityId,
    summary: description.summary,
    details: description.details,
    clientCommandId: item.request.clientCommandId,
    status: item.status === 'needs_attention' ? 'needs_attention' : 'pending',
    occurredAt: item.request.occurredAt ?? item.createdAt,
    confirmedAt: null,
    errorMessage: item.errorMessage,
  };
}

function describePendingCommand(command: StoreCommand): Pick<ActivityLog, 'category' | 'action' | 'entityType' | 'entityId' | 'summary' | 'details'> {
  switch (command.type) {
    case 'saveProduct': return { category: 'products', action: command.payload.id ? 'product.updated' : 'product.created', entityType: 'product', entityId: command.payload.id ?? null, summary: `${command.payload.id ? 'Updated' : 'Created'} product ${command.payload.name}`, details: { after: { name: command.payload.name, category: command.payload.category, barcode: command.payload.barcode ?? null, costPrice: command.payload.costPrice, sellingPrice: command.payload.sellingPrice, stockQuantity: command.payload.stockQuantity, unit: command.payload.unit, isActive: command.payload.isActive } } };
    case 'completeSale': return { category: 'sales', action: 'sale.completed', entityType: 'sale', entityId: command.payload.saleId, summary: `Completed sale ${command.payload.transactionNumber}`, details: { transactionNumber: command.payload.transactionNumber, paymentMethod: command.payload.paymentMethod, itemCount: command.payload.cart.length, cashReceived: command.payload.cashReceived, customerId: command.payload.customerId, utangPurchase: command.payload.paymentMethod === 'utang' } };
    case 'reviewQrPayment': return { category: 'sales', action: command.payload.decision === 'verify' ? 'payment.qrph_verified' : 'payment.qrph_rejected', entityType: 'qr_payment', entityId: command.payload.paymentId, summary: command.payload.decision === 'verify' ? 'Verified a QR Ph payment' : 'Marked a QR Ph payment unpaid', details: { decision: command.payload.decision, note: command.payload.note } };
    case 'adjustStock': return inventoryPending(command.payload.productId, 'inventory.adjusted', 'Adjusted product stock', command.payload);
    case 'restockProduct': return inventoryPending(command.payload.productId, 'inventory.restocked', 'Restocked product', command.payload);
    case 'receiveStock': return inventoryPending(command.payload.productId, 'inventory.restocked', 'Received product stock', command.payload);
    case 'countStock': return inventoryPending(command.payload.productId, 'inventory.counted', 'Counted product stock', command.payload);
    case 'adjustStockDelta': return inventoryPending(command.payload.productId, 'inventory.adjusted', 'Adjusted product stock', command.payload);
    case 'createCustomer': return { category: 'customers', action: 'customer.created', entityType: 'customer', entityId: null, summary: `Created customer ${command.payload.name}`, details: { name: command.payload.name } };
    case 'recordUtangPayment': return { category: 'utang', action: 'utang.payment_recorded', entityType: 'customer', entityId: command.payload.customerId, summary: 'Recorded an utang payment', details: { amount: command.payload.amount, note: command.payload.note } };
    case 'recordExpense': return { category: 'expenses', action: 'expense.recorded', entityType: 'expense', entityId: null, summary: `Recorded expense for ${command.payload.description}`, details: { category: command.payload.category, description: command.payload.description, amount: command.payload.amount, occurredAt: command.payload.occurredAt } };
  }
}

function inventoryPending(productId: string, action: string, summary: string, payload: Record<string, unknown>) {
  return { category: 'inventory' as const, action, entityType: 'product', entityId: productId, summary, details: safePendingDetails(payload) };
}

function safePendingDetails(payload: Record<string, unknown>) {
  const { expectedVersion: _expectedVersion, ...safe } = payload;
  return safe;
}

function matchesFilters(item: ActivityLog, filters: ActivityFiltersState) {
  if (filters.category && item.category !== filters.category) return false;
  if (filters.actorUserId && item.actor.userId !== filters.actorUserId) return false;
  if (filters.role && item.actor.role !== filters.role) return false;
  const localDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(item.occurredAt));
  if (filters.from && localDay < filters.from) return false;
  if (filters.to && localDay > filters.to) return false;
  const query = filters.q.toLocaleLowerCase();
  return !query || `${item.summary} ${item.action} ${item.actor.displayName}`.toLocaleLowerCase().includes(query);
}

function dedupeActivity(activity: ActivityLog[]) {
  return [...new Map(activity.map((item) => [item.id, item])).values()];
}

function formatActivityTime(value: string) {
  return new Intl.DateTimeFormat('en-PH', {
    timeZone: 'Asia/Manila', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  }).format(new Date(value));
}
