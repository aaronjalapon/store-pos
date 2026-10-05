'use client';

import { useEffect, useState } from 'react';
import type { AuthSession } from '@gma/contracts';
import { AlertTriangle, KeyRound, ShieldCheck, Store, Users } from 'lucide-react';
import { ApiRequestError, fetchSetupStatus, isInvalidSessionError, loginCashier, loginOwner, logout, rehydrateSession, setupOwner } from '../lib/api';
import { getActiveStoreId, getSession, hasCompletedBootstrap, signOutLocally } from '../lib/db';
import { PosApp } from './pos-app';
import { SuperadminConsole } from './superadmin-console';
import { waitForInitialConnection } from '../lib/initial-connection';

type Mode = 'loading' | 'connection-error' | 'setup' | 'owner' | 'cashier';

export function AuthShell() {
  const [mode, setMode] = useState<Mode>('loading');
  const [session, setSession] = useState<AuthSession | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [offlineReady, setOfflineReady] = useState(false);
  const [knownStoreId, setKnownStoreId] = useState('');
  const [online, setOnline] = useState(true);
  const [connectionAttempt, setConnectionAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setOnline(navigator.onLine);
    const handleOnline = () => setOnline(true);
    const handleOffline = () => setOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    void (async () => {
      const [localSession, bootstrapped, storeId] = await Promise.all([getSession(), hasCompletedBootstrap(), getActiveStoreId()]);
      if (!active) return;
      setKnownStoreId(storeId || '');
      if (localSession?.user.role === 'superadmin') {
        setSession(localSession);
        setOfflineReady(true);
        if (!navigator.onLine) {
          setMode('owner');
          return;
        }
        try {
          const next = await rehydrateSession();
          if (!active) return;
          setSession(next ?? localSession);
          setMode('owner');
          return;
        } catch (error) {
          if (!active) return;
          if (isInvalidSessionError(error)) {
            await signOutLocally();
            if (!active) return;
            setSession(null);
            setOfflineReady(false);
            setMode('owner');
            setMessage('Your saved superadmin session is no longer valid. Please sign in again.');
          } else {
            setSession(localSession);
            setMode('owner');
          }
          return;
        }
      }
      if (localSession && bootstrapped) {
        setSession(localSession);
        setOfflineReady(true);
        if (!navigator.onLine) {
          setMode('owner');
          return;
        }
        try {
          const next = await rehydrateSession();
          if (!active) return;
          setSession(next ?? localSession);
          setMode('owner');
          return;
        } catch (error) {
          if (!active) return;
          if (isInvalidSessionError(error)) {
            await signOutLocally();
            if (!active) return;
            setSession(null);
            setOfflineReady(false);
            setMode('owner');
            setMessage('Your saved browser session is no longer valid. Local sales remain on this device; sign in again to sync them.');
          } else {
            setSession(localSession);
            setOfflineReady(true);
            setMode('owner');
          }
          return;
        }
      }
      if (!navigator.onLine) {
        setMode('owner');
        setMessage('This browser must complete its first online sync before the POS can open.');
        return;
      }
      try {
        const status = await waitForInitialConnection((signal) => fetchSetupStatus(undefined, signal), controller.signal);
        if (!active) return;
        setMode(status.needsSetup ? 'setup' : 'owner');
      } catch (error) {
        if (!active) return;
        setMode('connection-error');
        setMessage(error instanceof Error ? error.message : 'Could not reach the server');
      }
    })();
    return () => {
      active = false;
      controller.abort();
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [connectionAttempt]);

  async function perform(work: () => Promise<AuthSession>) {
    setBusy(true);
    setMessage('');
    try {
      const next = await work();
      setSession(next);
      setOfflineReady(true);
      if (next.store) setKnownStoreId(next.store.id);
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 428) {
        const body = error.body as { code?: string; challengeId?: string; expiresAt?: string } | undefined;
        setMessage(body?.code === 'device_enrollment_required'
          ? `This browser is waiting for owner approval${body.expiresAt ? ` until ${new Date(body.expiresAt).toLocaleTimeString('en-PH')}` : ''}. Ask an owner or superadmin to approve “${body.challengeId?.slice(0, 8) ?? 'this request'}”, then sign in again.`
          : error.message);
      } else setMessage(error instanceof Error ? error.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  if (session && offlineReady) {
    if (session.store === null) {
      return <SuperadminConsole session={session} onLogout={async () => {
        await logout();
        setSession(null);
        setOfflineReady(false);
        setMode('owner');
      }} />;
    }
    return <PosApp session={session} onLogout={async () => {
      await logout();
      setSession(null);
      setOfflineReady(false);
      setMode(knownStoreId ? 'cashier' : 'owner');
    }} />;
  }

  return (
    <main className="auth-shell">
      <section className="auth-panel">
        <div className="auth-hero">
          <div className="brand-mark">G</div>
          <div>
            <p className="eyebrow">DEPLOYED STORE ACCESS</p>
            <h1>Sign in to your shared store</h1>
            <p>{online ? 'Server-authoritative data, offline cache after first sync, and role-based access for owners, admins, and cashiers.' : 'You are offline. First-time setup and first-time browser sync need an internet connection.'}</p>
          </div>
        </div>

        {mode === 'loading' && <p className="form-message auth-message" role="status">Connecting to the demo server… This may take up to two minutes on the first visit.</p>}
        {mode === 'connection-error' && <button className="primary-button" onClick={() => {
          setMessage('');
          setMode('loading');
          setConnectionAttempt((attempt) => attempt + 1);
        }}>Retry connection</button>}

        {mode !== 'loading' && mode !== 'connection-error' && <div className="auth-tabs">
          {mode === 'setup' && <button className="active"><Store size={16} /> First store setup</button>}
          {mode !== 'setup' && <button className={mode === 'owner' ? 'active' : ''} aria-pressed={mode === 'owner'} onClick={() => setMode('owner')}><ShieldCheck size={16} /> Manager</button>}
          {knownStoreId && <button className={mode === 'cashier' ? 'active' : ''} aria-pressed={mode === 'cashier'} onClick={() => setMode('cashier')}><Users size={16} /> Cashier</button>}
        </div>}

        {mode === 'setup' && <form className="stack-form auth-form" onSubmit={(event) => {
          event.preventDefault();
          const values = new FormData(event.currentTarget);
          void perform(() => setupOwner({
            storeName: values.get('storeName')!.toString(),
            displayName: values.get('displayName')!.toString(),
            email: values.get('email')!.toString(),
            password: values.get('password')!.toString(),
            deviceName: values.get('deviceName')!.toString(),
          }));
        }}>
          <label>Store name<input name="storeName" defaultValue="GMA Store" required /></label>
          <label>Owner name<input name="displayName" required /></label>
          <label>Owner email<input name="email" type="email" required /></label>
          <label>Password<input name="password" type="password" minLength={8} required /></label>
          <label>This browser’s name<input name="deviceName" defaultValue="Front counter browser" required /></label>
          <button className="primary-button" disabled={busy}><Store size={18} /> {busy ? 'Creating store…' : 'Create store and sign in'}</button>
        </form>}

        {mode === 'owner' && <form className="stack-form auth-form" onSubmit={(event) => {
          event.preventDefault();
          const values = new FormData(event.currentTarget);
          void perform(() => loginOwner({
            email: values.get('email')!.toString(),
            password: values.get('password')!.toString(),
            deviceName: values.get('deviceName')!.toString(),
          }));
        }}>
          <label>Email<input name="email" type="email" required /></label>
          <label>Password<input name="password" type="password" minLength={8} required /></label>
          <label>This browser’s name<input name="deviceName" defaultValue="Front counter browser" required /></label>
          <button className="primary-button" disabled={busy || !online}><ShieldCheck size={18} /> {busy ? 'Signing in…' : 'Sign in'}</button>
        </form>}

        {mode === 'cashier' && <form className="stack-form auth-form" onSubmit={(event) => {
          event.preventDefault();
          const values = new FormData(event.currentTarget);
          void perform(() => loginCashier({
            storeId: knownStoreId,
            staffCode: values.get('staffCode')!.toString(),
            pin: values.get('pin')!.toString(),
            deviceName: values.get('deviceName')!.toString(),
          }));
        }}>
          <label>Cashier code<input name="staffCode" required autoComplete="off" /></label>
          <label>PIN<input name="pin" type="password" minLength={4} required autoComplete="off" /></label>
          <label>This browser’s name<input name="deviceName" defaultValue="Front counter browser" required /></label>
          <button className="primary-button" disabled={busy || !online}><KeyRound size={18} /> {busy ? 'Opening shift…' : 'Start cashier shift'}</button>
        </form>}

        {!!message && <p className="form-message auth-message"><AlertTriangle size={16} /> {message}</p>}
      </section>
    </main>
  );
}
