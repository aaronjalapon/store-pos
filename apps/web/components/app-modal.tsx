'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';

interface AppModalProps {
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  closeLabel?: string;
}

export function AppModal({ title, description, onClose, children, className = '', closeLabel = 'Close dialog' }: AppModalProps) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focusTimer = requestAnimationFrame(() => {
      const target = dialogRef.current?.querySelector<HTMLElement>('[data-autofocus]')
        ?? dialogRef.current?.querySelector<HTMLElement>('input:not([disabled]), button:not([disabled]), select:not([disabled]), textarea:not([disabled])');
      target?.focus();
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); closeRef.current(); return; }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'));
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      cancelAnimationFrame(focusTimer);
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, []);

  return <div className="modal-backdrop"><div ref={dialogRef} className={`app-modal ${className}`} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={description ? descriptionId : undefined}><div className="modal-header app-modal-header"><div><strong id={titleId}>{title}</strong>{description && <p id={descriptionId}>{description}</p>}</div><button type="button" className="icon-button" onClick={onClose} aria-label={closeLabel}><X /></button></div><div className="app-modal-body">{children}</div></div></div>;
}

interface ConfirmModalProps {
  title: string;
  description: string;
  confirmLabel: string;
  onConfirm: () => void | Promise<void>;
  onClose: () => void;
  cancelLabel?: string;
  tone?: 'primary' | 'danger';
  children?: ReactNode;
}

export function ConfirmModal({ title, description, confirmLabel, onConfirm, onClose, cancelLabel = 'Cancel', tone = 'primary', children }: ConfirmModalProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return <AppModal title={title} description={description} onClose={busy ? () => undefined : onClose} className="confirm-modal"><div className={`confirm-symbol ${tone}`} aria-hidden="true">{tone === 'danger' ? '!' : '?'}</div>{children}{error && <p className="form-message error">{error}</p>}<div className="modal-actions"><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>{cancelLabel}</button><button type="button" data-autofocus className={tone === 'danger' ? 'danger-button' : 'primary-button'} disabled={busy} onClick={async () => { setBusy(true); setError(''); try { await onConfirm(); } catch (caught) { setError(caught instanceof Error ? caught.message : 'Could not complete this action'); setBusy(false); } }}>{busy ? 'Working…' : confirmLabel}</button></div></AppModal>;
}

export function AlertModal({ title, description, buttonLabel = 'Okay', onClose }: { title: string; description: string; buttonLabel?: string; onClose: () => void }) {
  return <AppModal title={title} description={description} onClose={onClose} className="confirm-modal"><div className="confirm-symbol" aria-hidden="true">!</div><div className="modal-actions single"><button type="button" data-autofocus className="primary-button" onClick={onClose}>{buttonLabel}</button></div></AppModal>;
}
