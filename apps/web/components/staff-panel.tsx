'use client';

import { useEffect, useState } from 'react';
import type { StaffMember } from '@gma/contracts';
import { KeyRound, Shield, Users } from 'lucide-react';
import { createStaff, disableStaff, isManagerAccessDenied, listStaff, resetStaffSecret } from '../lib/api';

export function StaffPanel({ onAccessDenied, disabled = false }: {
  onAccessDenied?: (message: string) => void;
  disabled?: boolean;
}) {
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
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
      const nextStaff = await listStaff();
      setStaff(nextStaff);
      setMessage('');
    } catch (error) {
      handleError(error);
    }
  };

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const nextStaff = await listStaff();
        if (!active) return;
        setStaff(nextStaff);
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

  async function run(work: () => Promise<void>, success: string) {
    setBusy(true);
    setMessage('');
    try {
      await work();
      await refresh();
      setMessage(success);
    } catch (error) {
      handleError(error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="settings-card">
      <div className="section-heading">
        <div><p className="eyebrow">ACCESS CONTROL</p><h2>Staff</h2></div>
        <Users />
      </div>
      <form className="stack-form" onSubmit={(event) => {
        event.preventDefault();
        const values = new FormData(event.currentTarget);
        const role = values.get('role')!.toString() as 'admin' | 'cashier';
        void run(async () => {
          if (role === 'admin') {
            await createStaff({
              role,
              displayName: values.get('displayName')!.toString(),
              email: values.get('email')!.toString(),
              password: values.get('secret')!.toString(),
            });
          } else {
            await createStaff({
              role,
              displayName: values.get('displayName')!.toString(),
              staffCode: values.get('staffCode')!.toString(),
              pin: values.get('secret')!.toString(),
            });
          }
          event.currentTarget.reset();
        }, `${role === 'admin' ? 'Admin' : 'Cashier'} created.`);
      }}>
        <label>Role<select name="role" defaultValue="cashier" disabled={disabled || accessDenied || busy}><option value="cashier">Cashier</option><option value="admin">Admin</option></select></label>
        <label>Display name<input name="displayName" required disabled={disabled || accessDenied || busy} /></label>
        <label>Email (admin only)<input name="email" placeholder="admin@gma.store" disabled={disabled || accessDenied || busy} /></label>
        <label>Staff code (cashier only)<input name="staffCode" placeholder="CASH001" disabled={disabled || accessDenied || busy} /></label>
        <label>Password / PIN<input name="secret" required autoComplete="off" disabled={disabled || accessDenied || busy} /></label>
        <button className="primary-button" disabled={disabled || accessDenied || busy}><Shield size={18} /> Add staff</button>
      </form>
      <div className="recent-expenses">
        <strong>Current staff</strong>
        {staff.map((member) => (
          <div key={member.id} className="staff-row">
            <span>
              {member.displayName}
              <small>{member.role.toUpperCase()} · {member.email || member.staffCode || 'No login id'} · {member.isActive ? 'Active' : 'Disabled'}</small>
            </span>
            <div className="staff-actions">
              <button type="button" className="secondary-button compact" disabled={disabled || accessDenied || busy} onClick={() => void run(async () => {
                if (member.role === 'cashier') await resetStaffSecret(member.id, { pin: '1234' });
                else await resetStaffSecret(member.id, { password: 'ChangeMe123!' });
              }, `${member.displayName}'s ${member.role === 'cashier' ? 'PIN' : 'password'} was reset.`)}>
                <KeyRound size={16} /> Reset
              </button>
              {member.role !== 'owner' && member.isActive && <button type="button" className="danger-button" disabled={disabled || accessDenied || busy} onClick={() => void run(async () => {
                await disableStaff(member.id);
              }, `${member.displayName} disabled.`)}>Disable</button>}
            </div>
          </div>
        ))}
      </div>
      {message && <p className="form-message">{message}</p>}
    </section>
  );
}
