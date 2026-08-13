'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Camera, X } from 'lucide-react';

interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<Array<{ rawValue: string }>>;
}

export interface BarcodeSuggestion {
  code: string;
  label: string;
  detail?: string;
}

export function CameraScanner({
  onCode, onClose, suggestions = [], suggestionLabel = 'Matching barcodes',
}: {
  onCode: (code: string) => void;
  onClose: () => void;
  suggestions?: BarcodeSuggestion[];
  suggestionLabel?: string;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const listboxId = useId();
  const [message, setMessage] = useState('Starting camera…');
  const [barcode, setBarcode] = useState('');
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const normalized = barcode.trim().toLocaleLowerCase();
  const matches = normalized ? suggestions
    .filter((suggestion) => [suggestion.code, suggestion.label, suggestion.detail].some((value) => value?.toLocaleLowerCase().includes(normalized)))
    .sort((left, right) => Number(!left.code.toLocaleLowerCase().includes(normalized)) - Number(!right.code.toLocaleLowerCase().includes(normalized)))
    .slice(0, 8) : [];
  const hasSuggestionSearch = suggestions.length > 0;

  const choose = (code: string) => {
    setBarcode(code);
    onCode(code);
  };

  useEffect(() => {
    let stream: MediaStream | null = null;
    let frame = 0;
    let cancelled = false;

    async function start() {
      const Detector = (window as unknown as { BarcodeDetector?: new (options: { formats: string[] }) => BarcodeDetectorLike }).BarcodeDetector;
      if (!Detector) {
        setMessage('Camera barcode detection is not supported here. Use search or type the barcode below.');
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
        if (!videoRef.current || cancelled) return;
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
        setMessage('Point the camera at a barcode');
        const detector = new Detector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128'] });
        const scan = async () => {
          if (cancelled || !videoRef.current) return;
          try {
            const results = await detector.detect(videoRef.current);
            if (results[0]?.rawValue) {
              navigator.vibrate?.(60);
              onCode(results[0].rawValue);
              return;
            }
          } catch { /* Frames can fail while the camera warms up. */ }
          frame = requestAnimationFrame(scan);
        };
        frame = requestAnimationFrame(scan);
      } catch {
        setMessage('Camera permission was denied. You can still search or use a Bluetooth scanner.');
      }
    }

    void start();
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, [onCode]);

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Scan barcode">
      <div className="scanner-card">
        <button className="icon-button scanner-close" onClick={onClose} aria-label="Close scanner"><X /></button>
        <div className="scanner-stage">
          <video ref={videoRef} muted playsInline />
          <div className="scan-window" />
          <Camera className="scanner-placeholder" />
        </div>
        <p>{message}</p>
        <form onSubmit={(event) => {
          event.preventDefault();
          const value = barcode.trim();
          if (value) onCode(value);
        }} className="manual-barcode">
          <div className="barcode-search-field">
            <input
              name="barcode"
              inputMode="numeric"
              placeholder={hasSuggestionSearch ? 'Search or enter barcode' : 'Enter barcode'}
              aria-label="Barcode"
              autoComplete="off"
              value={barcode}
              role={hasSuggestionSearch ? 'combobox' : undefined}
              aria-autocomplete={hasSuggestionSearch ? 'list' : undefined}
              aria-expanded={hasSuggestionSearch ? open : undefined}
              aria-controls={hasSuggestionSearch ? listboxId : undefined}
              aria-activedescendant={open && matches.length ? `${listboxId}-${highlighted}` : undefined}
              onFocus={() => setOpen(true)}
              onChange={(event) => { setBarcode(event.target.value); setOpen(true); setHighlighted(0); }}
              onKeyDown={(event) => {
                if (!hasSuggestionSearch) return;
                if (event.key === 'ArrowDown') {
                  event.preventDefault();
                  setOpen(true);
                  setHighlighted((current) => Math.min(Math.max(matches.length - 1, 0), current + 1));
                }
                if (event.key === 'ArrowUp') {
                  event.preventDefault();
                  setOpen(true);
                  setHighlighted((current) => Math.max(0, current - 1));
                }
                if (event.key === 'Escape') setOpen(false);
                if (event.key === 'Enter' && open && matches.length) {
                  event.preventDefault();
                  choose(matches[Math.min(highlighted, matches.length - 1)].code);
                }
              }}
            />
            {hasSuggestionSearch && open && matches.length > 0 && <div id={listboxId} className="barcode-suggestions" role="listbox" aria-label={suggestionLabel}>
              {matches.map((suggestion, index) => <button
                type="button"
                id={`${listboxId}-${index}`}
                role="option"
                aria-selected={index === highlighted}
                className={index === highlighted ? 'highlighted' : ''}
                key={`${suggestion.code}-${suggestion.label}`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(suggestion.code)}
              >
                <strong>{suggestion.code}</strong>
                <span>{suggestion.label}</span>
                {suggestion.detail && <small>{suggestion.detail}</small>}
              </button>)}
            </div>}
          </div>
          <button className="secondary-button" type="submit">Use code</button>
        </form>
      </div>
    </div>
  );
}
