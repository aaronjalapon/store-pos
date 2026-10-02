'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

const modalStack: string[] = [];
let previousBodyOverflow = '';

function updateModalLayers() {
  const topModalId = modalStack.at(-1);
  document.querySelectorAll<HTMLElement>('[data-modal-layer]').forEach((layer) => {
    const isTopLayer = layer.dataset.modalLayer === topModalId;
    layer.toggleAttribute('inert', !isTopLayer);
    if (isTopLayer) layer.removeAttribute('aria-hidden');
    else layer.setAttribute('aria-hidden', 'true');
  });
  const appRoot = document.querySelector<HTMLElement>('[data-app-root]');
  appRoot?.toggleAttribute('inert', modalStack.length > 0);
  if (modalStack.length > 0) appRoot?.setAttribute('aria-hidden', 'true');
  else appRoot?.removeAttribute('aria-hidden');
}

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
  const modalId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  const [mounted, setMounted] = useState(false);
  closeRef.current = onClose;

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!mounted) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (modalStack.length === 0) previousBodyOverflow = document.body.style.overflow;
    modalStack.push(modalId);
    document.body.style.overflow = 'hidden';
    updateModalLayers();
    const focusTimer = requestAnimationFrame(() => {
      const target = dialogRef.current?.querySelector<HTMLElement>('[data-autofocus], [autofocus]')
        ?? dialogRef.current?.querySelector<HTMLElement>('input:not([disabled]), button:not([disabled]), select:not([disabled]), textarea:not([disabled])');
      (target ?? dialogRef.current)?.focus();
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (modalStack.at(-1) !== modalId) return;
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
      const index = modalStack.lastIndexOf(modalId);
      if (index >= 0) modalStack.splice(index, 1);
      updateModalLayers();
      if (modalStack.length === 0) document.body.style.overflow = previousBodyOverflow;
      previousFocus?.focus();
    };
  }, [modalId, mounted]);

  if (!mounted) return null;

  return createPortal(<div className="modal-backdrop" data-modal-layer={modalId}><div ref={dialogRef} tabIndex={-1} className={`app-modal ${className}`} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={description ? descriptionId : undefined}><div className="modal-header app-modal-header"><div><strong id={titleId}>{title}</strong>{description && <p id={descriptionId}>{description}</p>}</div><button type="button" className="icon-button" onClick={onClose} aria-label={closeLabel}><X /></button></div><div className="app-modal-body">{children}</div></div></div>, document.body);
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
