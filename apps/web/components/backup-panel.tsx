'use client';

import { useEffect, useState } from 'react';
import { CheckCircle2, CloudOff, RefreshCw, ShieldCheck } from 'lucide-react';
import { isManagerAccessDenied } from '../lib/api';
import { createAndUploadBackup, getBackupStatus } from '../lib/backup';

interface Status {
  latestBackupAt: string | null;
  backupCount: number;
}

export function BackupPanel({ onAccessDenied, disabled = false }: {
  onAccessDenied?: (message: string) => void;
  disabled?: boolean;
}) {
  const [status, setStatus] = useState<Status>({ latestBackupAt: null, backupCount: 0 });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [accessDenied, setAccessDenied] = useState(false);

  const handleError = (error: unknown) => {
    const nextMessage = error instanceof Error ? error.message : 'Something went wrong';
    setMessage(nextMessage);
    if (isManagerAccessDenied(error)) {
      setAccessDenied(true);
      onAccessDenied?.(nextMessage);
    }
  };

  const refresh = async () => {
    try {
      const nextStatus = await getBackupStatus();
      setStatus(nextStatus);
      setMessage('');
    } catch (error) {
      handleError(error);
    }
  };

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const nextStatus = await getBackupStatus();
        if (!active) return;
        setStatus(nextStatus);
        setMessage('');
      } catch (error) {
        if (!active) return;
        handleError(error);
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, []);

  async function perform() {
    setBusy(true);
    setMessage('');
    try {
      const next = await createAndUploadBackup();
      setStatus(next);
      setMessage('Server backup completed.');
    } catch (error) {
      handleError(error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="settings-card">
      <div className="section-heading">
        <div><p className="eyebrow">DISASTER RECOVERY</p><h2>Server backups</h2></div>
        {status.backupCount ? <CheckCircle2 className="success-icon" /> : <CloudOff />}
      </div>
      <p className="muted">Backups are generated from the server-side store data, so every authenticated browser/device shares the same recovery source.</p>
      <div className="backup-status">
        <span>Last backup</span>
        <strong>{status.latestBackupAt ? new Date(status.latestBackupAt).toLocaleString('en-PH') : 'No backup yet'}</strong>
        <span>{status.backupCount ? `${status.backupCount} backup snapshot${status.backupCount === 1 ? '' : 's'} stored` : 'Create the first protected snapshot now'}</span>
      </div>
      <div className="button-row">
        <button className="primary-button" disabled={disabled || accessDenied || busy || (typeof navigator !== 'undefined' && !navigator.onLine)} onClick={() => void perform()}>
          <RefreshCw size={18} /> {busy ? 'Backing up…' : 'Create backup'}
        </button>
        <button className="secondary-button" disabled={disabled || accessDenied || busy} onClick={() => void refresh()}>
          <ShieldCheck size={18} /> Refresh status
        </button>
      </div>
      {message && <p className="form-message">{message}</p>}
    </section>
  );
}
