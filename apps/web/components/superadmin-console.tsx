'use client';

import { useEffect, useState } from 'react';
import type { SuperadminAuthSession, SuperadminStoreSummary } from '@gma/contracts';
import { LogOut, Plus, ShieldCheck, Store, UserRoundPlus, Users } from 'lucide-react';
import { createSuperadminStore, createSuperadminStoreStaff, listSuperadminStores } from '../lib/api';

export function SuperadminConsole({ session, onLogout }: {
  session: SuperadminAuthSession;
  onLogout: () => Promise<void>;
}) {
  const [stores, setStores] = useState<SuperadminStoreSummary[]>([]);
  const [selectedStoreId, setSelectedStoreId] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const selectedStore = stores.find((store) => store.id === selectedStoreId) ?? stores[0] ?? null;

  const refresh = async () => {
    const nextStores = await listSuperadminStores();
    setStores(nextStores);
    setSelectedStoreId((current) => current || nextStores[0]?.id || '');
  };

  useEffect(() => {
    void refresh().catch((error) => setMessage(error instanceof Error ? error.message : 'Could not load stores'));
  }, []);

  async function run(work: () => Promise<void>, success: string) {
    setBusy(true);
    setMessage('');
    try {
      await work();
      await refresh();
      setMessage(success);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="store-wordmark"><div className="brand-mark small">G</div><div><strong>Superadmin</strong><span>STORE CONTROL</span></div></div>
        <div className="topbar-actions">
          <div className="session-pill"><strong>{session.user.displayName}</strong><span>SUPERADMIN</span></div>
          <button className="secondary-button compact" onClick={() => void onLogout()}><LogOut size={16} /> Logout</button>
        </div>
      </header>
      <section className="page-panel">
        <div className="page-header">
          <div><p className="eyebrow">GLOBAL ACCESS</p><h1>Stores</h1><p>Create stores and assign owner or admin access.</p></div>
        </div>
        {message && <p className="form-message">{message}</p>}
        <div className="more-grid">
          <section className="settings-card">
            <div className="section-heading"><div><p className="eyebrow">NEW STORE</p><h2>Create store</h2></div><Store /></div>
            <form className="stack-form" onSubmit={(event) => {
              event.preventDefault();
              const form = event.currentTarget;
              const values = new FormData(form);
              void run(async () => {
                await createSuperadminStore({
                  storeName: values.get('storeName')!.toString(),
                  ownerDisplayName: values.get('ownerDisplayName')!.toString(),
                  ownerEmail: values.get('ownerEmail')!.toString(),
                  ownerPassword: values.get('ownerPassword')!.toString(),
                });
                form.reset();
              }, 'Store and owner created.');
            }}>
              <label>Store name<input name="storeName" required disabled={busy} /></label>
              <label>Owner name<input name="ownerDisplayName" required disabled={busy} /></label>
              <label>Owner email<input name="ownerEmail" type="email" required disabled={busy} /></label>
              <label>Owner password<input name="ownerPassword" type="password" minLength={8} required disabled={busy} /></label>
              <button className="primary-button" disabled={busy}><Plus /> Create store</button>
            </form>
          </section>

          <section className="settings-card">
            <div className="section-heading"><div><p className="eyebrow">ACCESS</p><h2>Add owner/admin</h2></div><UserRoundPlus /></div>
            <form className="stack-form" onSubmit={(event) => {
              event.preventDefault();
              const form = event.currentTarget;
              const values = new FormData(form);
              const storeId = values.get('storeId')!.toString();
              const role = values.get('role')!.toString() as 'owner' | 'admin';
              void run(async () => {
                await createSuperadminStoreStaff(storeId, {
                  role,
                  displayName: values.get('displayName')!.toString(),
                  email: values.get('email')!.toString(),
                  password: values.get('password')!.toString(),
                });
                form.reset();
              }, `${role === 'owner' ? 'Owner' : 'Admin'} access created.`);
            }}>
              <label>Store<select name="storeId" value={selectedStore?.id ?? ''} onChange={(event) => setSelectedStoreId(event.target.value)} required disabled={busy || !stores.length}>{stores.map((store) => <option key={store.id} value={store.id}>{store.name}</option>)}</select></label>
              <label>Role<select name="role" defaultValue="admin" disabled={busy || !stores.length}><option value="admin">Admin</option><option value="owner">Owner</option></select></label>
              <label>Name<input name="displayName" required disabled={busy || !stores.length} /></label>
              <label>Email<input name="email" type="email" required disabled={busy || !stores.length} /></label>
              <label>Password<input name="password" type="password" minLength={8} required disabled={busy || !stores.length} /></label>
              <button className="primary-button" disabled={busy || !stores.length}><ShieldCheck /> Add access</button>
            </form>
          </section>
        </div>

        <section className="report-card">
          <div className="section-heading"><div><p className="eyebrow">DIRECTORY</p><h2>All stores</h2></div><Users /></div>
          <div className="recent-expenses">
            {stores.length ? stores.map((store) => (
              <div key={store.id}>
                <span>{store.name}<small>{store.ownerCount} owner · {store.adminCount} admin · {store.cashierCount} cashier</small></span>
                <b>{new Date(store.createdAt).toLocaleDateString('en-PH')}</b>
              </div>
            )) : <p className="muted">No stores yet.</p>}
          </div>
        </section>
      </section>
    </main>
  );
}
