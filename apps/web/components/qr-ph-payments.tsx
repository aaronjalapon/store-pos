'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { QrPayment, Sale } from '@gma/contracts';
import { AlertTriangle, Check, ImageIcon, Trash2, Upload, WalletCards } from 'lucide-react';
import { formatPeso } from '@gma/domain';
import { deleteQrPhImage, getCachedQrPhImage, uploadQrPhImage } from '../lib/qr-ph';
import { reviewQrPayment } from '../lib/pos';
import { AppModal } from './app-modal';

export function useQrPhImageUrl() {
  const [url, setUrl] = useState('');
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let active = true;
    let objectUrl = '';
    const load = async () => {
      const cached = await getCachedQrPhImage().catch(() => null);
      if (!active) return;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      try { objectUrl = cached ? URL.createObjectURL(cached.image.blob) : ''; } catch { objectUrl = ''; }
      setUrl(objectUrl);
      setReady(Boolean(cached));
    };
    const changed = () => void load();
    void load();
    window.addEventListener('pos-qrph-changed', changed);
    window.addEventListener('pos-data-changed', changed);
    return () => {
      active = false;
      window.removeEventListener('pos-qrph-changed', changed);
      window.removeEventListener('pos-data-changed', changed);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, []);
  return { url, ready };
}

export function QrPhSettingsCard() {
  const inputRef = useRef<HTMLInputElement>(null);
  const { url, ready } = useQrPhImageUrl();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const choose = async (file?: File) => {
    if (!file) return;
    setBusy(true); setMessage(''); setError('');
    try {
      await uploadQrPhImage(file);
      setMessage('QR Ph code saved and cached on this device. Synchronize other store devices after replacing it.');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not upload QR Ph image');
    } finally { setBusy(false); }
  };

  return <section className="settings-card qr-settings-card"><div className="section-heading"><div><p className="eyebrow">PAYMENT SETUP</p><h2>Static QR Ph</h2></div><WalletCards /></div><p className="muted">Upload the store’s official merchant QR. It will remain available for offline checkout on every device after synchronization.</p><div className="qr-settings-preview">{url ? <img src={url} alt="Configured store QR Ph code" /> : <div><ImageIcon /><span>No QR configured</span></div>}</div><input ref={inputRef} className="visually-hidden" type="file" accept="image/png,image/webp,image/jpeg" onChange={(event) => { void choose(event.target.files?.[0]); event.currentTarget.value = ''; }} /><div className="button-row"><button type="button" className="primary-button" disabled={busy} onClick={() => inputRef.current?.click()}><Upload /> {busy ? 'Uploading…' : ready ? 'Replace QR' : 'Upload QR'}</button>{ready && <button type="button" className="danger-button" disabled={busy} onClick={async () => { setBusy(true); setMessage(''); setError(''); try { await deleteQrPhImage(); setMessage('QR Ph payment has been disabled.'); } catch (caught) { setError(caught instanceof Error ? caught.message : 'Could not remove QR Ph image'); } finally { setBusy(false); } }}><Trash2 /> Remove</button>}</div>{message && <p className="form-message">{message}</p>}{error && <p className="form-message error" role="alert">{error}</p>}{ready && <p className="qr-rotation-warning"><AlertTriangle /> Replacing a QR does not update devices that remain offline. Synchronize them before retiring the old code.</p>}</section>;
}

export function QrPaymentReviewPanel({ payments, sales }: { payments: QrPayment[]; sales: Sale[] }) {
  const pending = useMemo(() => payments.filter((payment) => payment.status === 'pending_review').sort((a, b) => a.confirmedAt.localeCompare(b.confirmedAt)), [payments]);
  const salesById = useMemo(() => new Map(sales.map((sale) => [sale.id, sale])), [sales]);
  const [reviewing, setReviewing] = useState<QrPayment | null>(null);
  const [decision, setDecision] = useState<'verify' | 'reject'>('verify');

  return <section className="report-card qr-review-card"><div className="section-heading"><div><p className="eyebrow">QR RECONCILIATION</p><h2>Payment review</h2></div><WalletCards /></div>{pending.length ? <div className="qr-review-list">{pending.map((payment) => { const sale = salesById.get(payment.saleId); return <article key={payment.id}><div><span className={`payment-status ${payment.attentionReason === 'duplicate_reference' ? 'danger' : 'warning'}`}>{payment.attentionReason === 'duplicate_reference' ? 'Duplicate reference' : 'Customer proof'}</span><strong>{sale?.transactionNumber ?? 'Sale'}</strong><small>{payment.cashierDisplayNameSnapshot} · {new Date(payment.confirmedAt).toLocaleString('en-PH')}</small><code>{payment.reference}</code></div><div><strong>{formatPeso(payment.amount)}</strong><button className="secondary-button compact" onClick={() => { setReviewing(payment); setDecision('verify'); }}>Review</button></div></article>; })}</div> : <div className="empty-cart compact-empty"><Check /><strong>No payments awaiting review</strong><p>Customer-proof and duplicate-reference payments will appear here.</p></div>}{reviewing && <QrReviewModal payment={reviewing} decision={decision} onDecision={setDecision} onClose={() => setReviewing(null)} onSaved={() => setReviewing(null)} />}</section>;
}

function QrReviewModal({ payment, decision, onDecision, onClose, onSaved }: {
  payment: QrPayment;
  decision: 'verify' | 'reject';
  onDecision: (decision: 'verify' | 'reject') => void;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return <AppModal title="Review QR Ph payment" description={`${formatPeso(payment.amount)} · Reference ${payment.reference}`} onClose={busy ? () => undefined : onClose}><div className="stock-mode-toggle"><button type="button" className={decision === 'verify' ? 'active' : ''} onClick={() => onDecision('verify')}>Verify received</button><button type="button" className={decision === 'reject' ? 'active' : ''} onClick={() => onDecision('reject')}>Mark unpaid</button></div><p className={decision === 'reject' ? 'restore-warning' : 'form-message'}>{decision === 'reject' ? 'The sale and stock movement will remain. Its amount will be reported as an unpaid loss.' : 'Confirm that the reference and amount appear in the merchant account.'}</p><label className="qr-review-note">Review note {decision === 'reject' ? '(required)' : '(optional)'}<textarea value={note} maxLength={200} onChange={(event) => setNote(event.target.value)} placeholder={decision === 'reject' ? 'Why was this payment rejected?' : 'Reconciliation details'} /></label>{error && <p className="form-message error" role="alert">{error}</p>}<div className="modal-actions"><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>Cancel</button><button type="button" className={decision === 'reject' ? 'danger-button' : 'primary-button'} disabled={busy || (decision === 'reject' && !note.trim())} onClick={async () => { setBusy(true); setError(''); try { await reviewQrPayment(payment.id, decision, note); onSaved(); } catch (caught) { setError(caught instanceof Error ? caught.message : 'Could not review payment'); setBusy(false); } }}>{busy ? 'Saving…' : decision === 'verify' ? 'Verify payment' : 'Mark unpaid'}</button></div></AppModal>;
}
