'use client';

import { useCallback, useEffect, useState } from 'react';
import type { StaffMember, SuperadminAuthSession, SuperadminStoreDetailsResponse, SuperadminStoreSummary } from '@gma/contracts';
import { Activity, CheckCircle2, Cloud, KeyRound, LogOut, Plus, ShieldCheck, Store, UserRoundPlus, Users, XCircle } from 'lucide-react';
import {
  createSuperadminStore,
  createSuperadminStoreStaff,
  getSuperadminStoreDetails,
  listSuperadminStores,
  resetSuperadminStaffSecret,
  updateSuperadminStaffStatus,
  updateSuperadminStoreStatus,
} from '../lib/api';
import { ConfirmModal } from './app-modal';

export function SuperadminConsole({ session, onLogout }: {
  session: SuperadminAuthSession;
  onLogout: () => Promise<void>;
}) {
  const [stores, setStores] = useState<SuperadminStoreSummary[]>([]);
  const [selectedStoreId, setSelectedStoreId] = useState('');
  const [details, setDetails] = useState<SuperadminStoreDetailsResponse | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [pendingStoreStatus, setPendingStoreStatus] = useState<boolean | null>(null);
  const [pendingMember, setPendingMember] = useState<{ member: StaffMember; isActive: boolean } | null>(null);
  const [resetMember, setResetMember] = useState<StaffMember | null>(null);
  const [resetPassword, setResetPassword] = useState('');

  const selectedStore = stores.find((store) => store.id === selectedStoreId) ?? stores[0] ?? null;

  const loadDetails = useCallback(async (storeId: string) => {
    const nextDetails = await getSuperadminStoreDetails(storeId);
    setDetails(nextDetails);
  }, []);

  const refresh = useCallback(async (preferredStoreId = '') => {
    const nextStores = await listSuperadminStores();
    setStores(nextStores);
    const nextStoreId = preferredStoreId || nextStores[0]?.id || '';
    setSelectedStoreId(nextStoreId);
    if (nextStoreId) await loadDetails(nextStoreId);
    else setDetails(null);
  }, [loadDetails]);

  useEffect(() => {
    void refresh().catch((error) => setMessage(error instanceof Error ? error.message : 'Could not load stores'));
  }, [refresh]);

  useEffect(() => {
    if (!selectedStoreId) return;
    void loadDetails(selectedStoreId).catch((error) => setMessage(error instanceof Error ? error.message : 'Could not load store details'));
  }, [loadDetails, selectedStoreId]);

  async function run(work: () => Promise<void>, success: string) {
    setBusy(true);
    setMessage('');
    try {
      await work();
      await refresh(selectedStoreId);
      setMessage(success);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  async function changeStoreStatus(isActive: boolean) {
    if (!selectedStore) return;
    setBusy(true);
    try {
      await updateSuperadminStoreStatus(selectedStore.id, { isActive });
      await refresh(selectedStore.id);
      setPendingStoreStatus(null);
      setMessage(isActive ? 'Store reactivated.' : 'Store suspended.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not update store status');
      throw error;
    } finally {
      setBusy(false);
    }
  }

  async function changeMemberStatus(member: StaffMember, isActive: boolean) {
    if (!selectedStore) return;
    setBusy(true);
    try {
      await updateSuperadminStaffStatus(selectedStore.id, member.id, { isActive });
      await refresh(selectedStore.id);
      setPendingMember(null);
      setMessage(isActive ? `${member.displayName} reactivated.` : `${member.displayName} suspended.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not update access status');
      throw error;
    } finally {
      setBusy(false);
    }
  }

  async function submitReset() {
    if (!selectedStore || !resetMember) return;
    if (resetPassword.length < 8) throw new Error('Password must be at least 8 characters');
    setBusy(true);
    try {
      await resetSuperadminStaffSecret(selectedStore.id, resetMember.id, { password: resetPassword });
      await refresh(selectedStore.id);
      setResetMember(null);
      setResetPassword('');
      setMessage(`${resetMember.displayName}'s password was reset.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not reset password');
      throw error;
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
          <div><p className="eyebrow">GLOBAL OVERSIGHT</p><h1>Stores</h1><p>Monitor store access and health, then manage owner and admin lifecycle controls.</p></div>
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
                <span><strong>{store.name}</strong><small>{store.isActive ? 'ACTIVE' : 'SUSPENDED'} · {store.ownerCount} owner · {store.adminCount} admin · {store.cashierCount} cashier</small></span>
                <button type="button" className="secondary-button compact" disabled={busy} onClick={() => setSelectedStoreId(store.id)}>Inspect</button>
              </div>
            )) : <p className="muted">No stores yet.</p>}
          </div>
        </section>

        {selectedStore && details && <StoreDetails
          details={details}
          busy={busy}
          onStoreStatus={() => setPendingStoreStatus(!details.store.isActive)}
          onMemberStatus={(member) => setPendingMember({ member, isActive: !member.isActive })}
          onReset={(member) => { setResetMember(member); setResetPassword(''); }}
        />}
      </section>

      {pendingStoreStatus !== null && selectedStore && <ConfirmModal
        title={pendingStoreStatus ? 'Reactivate store?' : 'Suspend store?'}
        description={pendingStoreStatus ? 'Store users will be able to sign in and sync again.' : 'This blocks new logins, sync, and store operations. Store data is preserved.'}
        confirmLabel={pendingStoreStatus ? 'Reactivate store' : 'Suspend store'}
        tone={pendingStoreStatus ? 'primary' : 'danger'}
        onClose={() => setPendingStoreStatus(null)}
        onConfirm={() => changeStoreStatus(pendingStoreStatus)}
      />}
      {pendingMember && <ConfirmModal
        title={pendingMember.isActive ? 'Reactivate access?' : 'Suspend access?'}
        description={`${pendingMember.member.displayName} will ${pendingMember.isActive ? 'be able' : 'no longer be able'} to sign in to this store.`}
        confirmLabel={pendingMember.isActive ? 'Reactivate access' : 'Suspend access'}
        tone={pendingMember.isActive ? 'primary' : 'danger'}
        onClose={() => setPendingMember(null)}
        onConfirm={() => changeMemberStatus(pendingMember.member, pendingMember.isActive)}
      />}
      {resetMember && <ConfirmModal
        title={`Reset ${resetMember.displayName}'s password?`}
        description="This replaces the current owner/admin password immediately."
        confirmLabel="Reset password"
        onClose={() => { setResetMember(null); setResetPassword(''); }}
        onConfirm={submitReset}
      >
        <label>New password<input data-autofocus type="password" minLength={8} value={resetPassword} onChange={(event) => setResetPassword(event.target.value)} /></label>
      </ConfirmModal>}
    </main>
  );
}

function StoreDetails({ details, busy, onStoreStatus, onMemberStatus, onReset }: {
  details: SuperadminStoreDetailsResponse;
  busy: boolean;
  onStoreStatus: () => void;
  onMemberStatus: (member: StaffMember) => void;
  onReset: (member: StaffMember) => void;
}) {
  const { store, staff } = details;
  return <section className="settings-card">
    <div className="section-heading">
      <div><p className="eyebrow">STORE OVERSIGHT</p><h2>{store.name}</h2><p>{store.isActive ? 'Active store' : 'Suspended store'}</p></div>
      {store.isActive ? <CheckCircle2 className="success-icon" /> : <XCircle />}
    </div>
    <div className="metric-grid">
      <div className="metric-card blue"><div><Users size={16} /><span>Access</span></div><strong>{store.ownerCount + store.adminCount + store.cashierCount}</strong><small>{store.ownerCount} owners · {store.adminCount} admins · {store.cashierCount} cashiers</small></div>
      <div className="metric-card green"><div><Activity size={16} /><span>Activity</span></div><strong>{formatTime(store.lastActivityAt)}</strong><small>Last store update</small></div>
      <div className="metric-card yellow"><div><Cloud size={16} /><span>Devices</span></div><strong>{formatTime(store.lastDeviceSeenAt)}</strong><small>Last device seen</small></div>
      <div className="metric-card red"><div><ShieldCheck size={16} /><span>Backups</span></div><strong>{store.backupCount}</strong><small>{store.latestBackupAt ? `Latest ${formatTime(store.latestBackupAt)}` : 'No backup yet'}</small></div>
    </div>
    <div className="button-row"><button type="button" className={store.isActive ? 'danger-button' : 'primary-button'} disabled={busy} onClick={onStoreStatus}>{store.isActive ? 'Suspend store' : 'Reactivate store'}</button></div>
    <div className="recent-expenses">
      <strong>Owners, admins, and cashiers</strong>
      {staff.map((member) => <div key={member.id}>
        <span>{member.displayName}<small>{member.role.toUpperCase()} · {member.email || member.staffCode || 'No login id'} · {member.isActive ? 'Active' : 'Suspended'}</small></span>
        {member.role === 'owner' || member.role === 'admin' ? <div className="staff-actions"><button type="button" className="secondary-button compact" disabled={busy} onClick={() => onReset(member)}><KeyRound size={16} /> Reset password</button><button type="button" className={member.isActive ? 'danger-button compact' : 'secondary-button compact'} disabled={busy} onClick={() => onMemberStatus(member)}>{member.isActive ? 'Suspend' : 'Reactivate'}</button></div> : null}
      </div>)}
    </div>
  </section>;
}

function formatTime(value: string | null) {
  return value ? new Date(value).toLocaleDateString('en-PH', { month: 'short', day: 'numeric' }) : '—';
}
