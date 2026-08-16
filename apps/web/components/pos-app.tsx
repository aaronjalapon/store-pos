'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isManagerRole } from '@gma/contracts';
import type { AuthSession, Customer, Expense, InventoryMovement, PaymentMethod, Product, ProductUnit, Sale, SaleItem, StoreAuthSession, UtangEntry } from '@gma/contracts';
import { calculateDailySummary, calculateUtangBalance, formatPeso } from '@gma/domain';
import {
  AlertTriangle, Archive, LogOut, PhilippinePeso, BarChart3, Camera, Check, ChevronDown, ChevronLeft, CircleUserRound, ImageIcon,
  Cloud, CreditCard, Minus, MoreHorizontal, PackageOpen, Plus, ReceiptText, Search,
  ShoppingBasket, Trash2, Upload, UserRoundPlus, WalletCards, Wifi, WifiOff, X,
} from 'lucide-react';
import { db, removeLocalStoreData } from '../lib/db';
import { centavosToPesoInput, pesoInputToCentavos } from '../lib/money';
import {
  adjustStock, completeSale, createCustomer, recordExpense, recordUtangPayment, saveProduct, type CartEntry,
  restockProduct, type ProductUnitInput,
} from '../lib/pos';
import { getCachedConflictMessage, getSyncState, isManagerAccessDenied, requestSync, retryNeedsAttention, type SyncState } from '../lib/api';
import { BackupPanel } from './backup-panel';
import { CameraScanner, type BarcodeSuggestion } from './camera-scanner';
import { compressProductImage, hydrateProductImage, type CompressedProductImage } from '../lib/product-images';
import { AlertModal, ConfirmModal } from './app-modal';
import { AddCustomerModal, QuickRestockModal, RecordPaymentModal, StockAdjustmentModal } from './pos-dialogs';
import { SearchableDropdown } from './searchable-dropdown';
import { StaffPanel } from './staff-panel';

type Tab = 'sell' | 'inventory' | 'utang' | 'reports' | 'more';

interface StoreData {
  products: Product[];
  productUnits: ProductUnit[];
  inventoryMovements: InventoryMovement[];
  customers: Customer[];
  sales: Sale[];
  saleItems: SaleItem[];
  utangEntries: UtangEntry[];
  expenses: Expense[];
}

const emptyData: StoreData = { products: [], productUnits: [], inventoryMovements: [], customers: [], sales: [], saleItems: [], utangEntries: [], expenses: [] };
const PRODUCT_CATEGORIES = ['Food', 'Drinks', 'Snacks', 'Frozen', 'Household', 'Personal care', 'Load / eLoad', 'Other'] as const;
const PRODUCT_UNITS = ['piece', 'kg', 'g', 'pack', 'sachet', 'bottle', 'can', 'bag', 'box', 'liter', 'milliliter', 'dozen'] as const;

function productQuantityStep(product: Product) {
  return product.soldByWeight ? product.quantityStep : 1;
}

function normalizeQuantity(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function formatQuantity(value: number) {
  return new Intl.NumberFormat('en-PH', { maximumFractionDigits: 6 }).format(value);
}

function productBarcodeSuggestions(products: Product[], options?: { includeInactive?: boolean; excludeProductId?: string | null }) {
  const includeInactive = options?.includeInactive ?? false;
  const excludeProductId = options?.excludeProductId ?? null;
  return products
    .filter((product) => product.barcode && (includeInactive || product.isActive) && product.id !== excludeProductId)
    .map<BarcodeSuggestion>((product) => ({
      code: product.barcode!,
      label: product.name,
      detail: `${product.category}${product.isActive ? '' : ' · Inactive'} · ${formatQuantity(product.stockQuantity)} ${product.unit}`,
    }));
}

export function PosApp({ session, onLogout }: { session: StoreAuthSession; onLogout: () => Promise<void> }) {
  const [tab, setTab] = useState<Tab>('sell');
  const [data, setData] = useState<StoreData>(emptyData);
  const [ready, setReady] = useState(false);
  const [online, setOnline] = useState(true);
  const [syncConflict, setSyncConflict] = useState('');
  const [syncState, setSyncState] = useState<SyncState>({
    phase: 'synced', pendingCount: 0, needsAttentionCount: 0, pendingSaleCount: 0,
    needsAttentionSaleCount: 0, completedCount: 0, totalCount: 0,
  });

  const canManageStore = isManagerRole(session.user.role);
  const availableTabs: Tab[] = canManageStore ? ['sell', 'inventory', 'utang', 'reports', 'more'] : ['sell', 'more'];

  const load = useCallback(async () => {
    setData({
      products: await db.products.toArray(), customers: await db.customers.toArray(), sales: await db.sales.toArray(),
      productUnits: await db.productUnits.toArray(),
      inventoryMovements: await db.inventoryMovements.toArray(),
      saleItems: await db.saleItems.toArray(), utangEntries: await db.utangEntries.toArray(), expenses: await db.expenses.toArray(),
    });
    setReady(true);
  }, []);

  useEffect(() => {
    let syncTimer: ReturnType<typeof setTimeout> | undefined;
    const loadSyncState = () => void getSyncState().then(setSyncState);
    void load();
    setOnline(navigator.onLine);
    void navigator.storage?.persist?.();
    if ('serviceWorker' in navigator) void navigator.serviceWorker.register('/sw.js');
    const changed = () => {
      void load();
      loadSyncState();
      clearTimeout(syncTimer);
      syncTimer = setTimeout(() => void requestSync(), 500);
    };
    const wentOnline = () => {
      setOnline(true);
      void requestSync().then(load);
    };
    const wentOffline = () => { setOnline(false); loadSyncState(); };
    const syncConflictChanged = () => void getCachedConflictMessage().then(setSyncConflict);
    window.addEventListener('pos-data-changed', changed);
    window.addEventListener('online', wentOnline);
    window.addEventListener('offline', wentOffline);
    window.addEventListener('pos-sync-conflict', syncConflictChanged);
    window.addEventListener('pos-sync-state-changed', loadSyncState);
    void getCachedConflictMessage().then(setSyncConflict);
    loadSyncState();
    void requestSync().then(load).catch(() => undefined);
    return () => {
      clearTimeout(syncTimer);
      window.removeEventListener('pos-data-changed', changed);
      window.removeEventListener('online', wentOnline);
      window.removeEventListener('offline', wentOffline);
      window.removeEventListener('pos-sync-conflict', syncConflictChanged);
      window.removeEventListener('pos-sync-state-changed', loadSyncState);
    };
  }, [load]);

  useEffect(() => {
    if (!availableTabs.includes(tab)) setTab('sell');
  }, [availableTabs, tab]);

  if (!ready) return <div className="app-loading"><div className="brand-mark">G</div><p>Opening store…</p></div>;

  const syncLabel = syncState.phase === 'needs_attention'
    ? `Needs attention · ${syncState.needsAttentionSaleCount || syncState.needsAttentionCount}`
    : syncState.phase === 'syncing'
      ? `Syncing ${syncState.completedCount} of ${syncState.totalCount}`
      : syncState.pendingCount > 0
        ? `${online ? 'Pending' : 'Offline'} · ${syncState.pendingSaleCount || syncState.pendingCount} ${syncState.pendingSaleCount ? 'sales' : 'changes'}`
        : syncState.phase === 'offline' ? 'Offline · locally saved' : 'Synced';
  const syncHealthy = syncState.phase === 'synced';

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="store-wordmark"><div className="brand-mark small">G</div><div><strong>{session.store.name}</strong><span>POINT OF SALE</span></div></div>
        <div className="topbar-actions">
          <div className={`connection-pill ${syncHealthy ? 'online' : ''}`}>{syncHealthy ? <Wifi size={15} /> : syncState.phase === 'syncing' ? <Cloud size={15} /> : <WifiOff size={15} />}{syncLabel}</div>
          <div className="session-pill"><strong>{session.user.displayName}</strong><span>{session.user.role.toUpperCase()}</span></div>
          <button className="secondary-button compact" onClick={() => void onLogout()}><LogOut size={16} /> Logout</button>
        </div>
      </header>
      <div className="content-area">
        {syncConflict && <div className="sync-conflict-banner"><AlertTriangle size={18} /><span>{syncConflict}</span><button className="secondary-button compact" onClick={() => void retryNeedsAttention()}>Retry sync</button></div>}
        {tab === 'sell' && <SellView products={data.products} productUnits={data.productUnits} customers={data.customers} allowProductCreation={canManageStore} />}
        {tab === 'inventory' && canManageStore && <InventoryView products={data.products} productUnits={data.productUnits} inventoryMovements={data.inventoryMovements} />}
        {tab === 'utang' && canManageStore && <UtangView customers={data.customers} entries={data.utangEntries} />}
        {tab === 'reports' && canManageStore && <ReportsView data={data} />}
        {tab === 'more' && <MoreView expenses={data.expenses} session={session} onLogout={onLogout} />}
      </div>
      <nav className="bottom-nav" aria-label="Primary navigation">
        <NavButton active={tab === 'sell'} label="Sell" icon={<ShoppingBasket />} onClick={() => setTab('sell')} />
        {canManageStore && <NavButton active={tab === 'inventory'} label="Inventory" icon={<Archive />} onClick={() => setTab('inventory')} />}
        {canManageStore && <NavButton active={tab === 'utang'} label="Utang" icon={<WalletCards />} onClick={() => setTab('utang')} />}
        {canManageStore && <NavButton active={tab === 'reports'} label="Reports" icon={<BarChart3 />} onClick={() => setTab('reports')} />}
        <NavButton active={tab === 'more'} label={canManageStore ? 'More' : 'Account'} icon={<MoreHorizontal />} onClick={() => setTab('more')} />
      </nav>
    </main>
  );
}

function NavButton({ active, label, icon, onClick }: { active: boolean; label: string; icon: React.ReactNode; onClick: () => void }) {
  return <button className={active ? 'active' : ''} onClick={onClick}>{icon}<span>{label}</span></button>;
}

function useModalBehavior(onClose: () => void) {
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKeyDown);
    return () => { document.body.style.overflow = previousOverflow; window.removeEventListener('keydown', onKeyDown); };
  }, [onClose]);
}

function ProductThumbnail({ product, className = '' }: { product: Product; className?: string }) {
  const [url, setUrl] = useState('');

  useEffect(() => {
    let active = true;
    let objectUrl = '';
    const loadImage = async () => {
      if (!product.imageRevision) { setUrl(''); return; }
      const local = await db.productImages.get(product.id) ?? await hydrateProductImage(product);
      if (!active || !local || local.revision !== product.imageRevision) return;
      objectUrl = URL.createObjectURL(local.blob);
      setUrl(objectUrl);
    };
    const changed = () => { if (objectUrl) URL.revokeObjectURL(objectUrl); objectUrl = ''; void loadImage(); };
    void loadImage();
    window.addEventListener('pos-images-changed', changed);
    return () => {
      active = false;
      window.removeEventListener('pos-images-changed', changed);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [product.id, product.imageRevision]);

  return <span className={`product-thumbnail ${className}`}>{url ? <img src={url} alt="" /> : <span>{product.name.charAt(0)}</span>}</span>;
}

function BlobPreview({ image, name }: { image: CompressedProductImage; name: string }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    const nextUrl = URL.createObjectURL(image.blob);
    setUrl(nextUrl);
    return () => URL.revokeObjectURL(nextUrl);
  }, [image]);
  return <span className="product-thumbnail image-preview">{url ? <img src={url} alt={`Preview for ${name || 'product'}`} /> : <ImageIcon />}</span>;
}

export function SellView({ products, productUnits = [], customers, allowProductCreation }: { products: Product[]; productUnits?: ProductUnit[]; customers: Customer[]; allowProductCreation: boolean }) {
  const [cart, setCart] = useState<CartEntry[]>([]);
  const [query, setQuery] = useState('');
  const [checkout, setCheckout] = useState(false);
  const [scanner, setScanner] = useState(false);
  const [cartOpen, setCartOpen] = useState(false);
  const [notice, setNotice] = useState('');
  const [unknownBarcode, setUnknownBarcode] = useState<string | null>(null);
  const [inactiveBarcodeProduct, setInactiveBarcodeProduct] = useState<Product | null>(null);
  const [newProductBarcode, setNewProductBarcode] = useState<string | null>(null);
  const [cartIssues, setCartIssues] = useState<Record<string, string>>({});
  const barcodeCallback = useRef<(code: string) => void>(() => undefined);

  const activeProducts = useMemo(() => products.filter((product) => product.isActive), [products]);
  const matching = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return [];
    return activeProducts.filter((product) => [product.name, product.barcode, product.sku, product.category]
      .some((field) => field?.toLowerCase().includes(normalized))).slice(0, 8);
  }, [activeProducts, query]);
  const barcodeSuggestions = useMemo(() => productBarcodeSuggestions(activeProducts), [activeProducts]);
  const formBarcodeSuggestions = useMemo(() => productBarcodeSuggestions(products), [products]);
  const unitsByProduct = useMemo(() => new Map(productUnits.map((unit) => [unit.productId, productUnits.filter((candidate) => candidate.productId === unit.productId)])), [productUnits]);
  const quickItems = activeProducts.filter((product) => product.isQuickItem).slice(0, 8);
  const lineSubtotal = (line: CartEntry) => line.pricingMode === 'amount' && line.enteredAmount
    ? line.enteredAmount
    : Math.round((line.unit?.sellingPrice ?? line.product.sellingPrice) * line.quantity);
  const total = cart.reduce((sum, line) => sum + lineSubtotal(line), 0);
  const hasCartIssues = Object.values(cartIssues).some(Boolean);

  const defaultUnit = useCallback((product: Product) => productUnits.find((unit) => unit.id === product.defaultSaleUnitId && unit.isActive && unit.canSell)
    ?? productUnits.find((unit) => unit.productId === product.id && unit.isActive && unit.canSell), [productUnits]);

  const addProduct = useCallback((product: Product, selectedUnit?: ProductUnit | null) => {
    if (product.stockQuantity <= 0) { setNotice(`${product.name} is out of stock`); return; }
    const unit = selectedUnit ?? defaultUnit(product);
    setCart((current) => {
      const existing = current.find((line) => line.product.id === product.id && (line.unit?.id ?? null) === (unit?.id ?? null));
      const addAmount = unit ? unit.quantityStep : product.soldByWeight ? Math.max(1, productQuantityStep(product)) : 1;
      if (existing) {
        if (existing.quantity >= (unit ? (product.stockBaseQuantity ?? product.stockQuantity) / unit.multiplierBaseUnits : product.stockQuantity)) { setNotice(`Not enough ${product.name} available`); return current; }
        return current.map((line) => line.product.id === product.id && (line.unit?.id ?? null) === (unit?.id ?? null)
          ? { ...line, quantity: normalizeQuantity(line.quantity + addAmount), pricingMode: 'quantity', enteredAmount: null } : line);
      }
      return [...current, { product, unit: unit ?? null, quantity: normalizeQuantity(addAmount), pricingMode: 'quantity', enteredAmount: null }];
    });
    setQuery(''); setNotice('');
  }, [defaultUnit]);

  const handleBarcode = useCallback((code: string) => {
    setScanner(false);
    const normalizedCode = code.trim();
    const unitMatch = productUnits.find((unit) => unit.barcode === normalizedCode && unit.isActive && unit.canSell);
    const product = unitMatch ? products.find((item) => item.id === unitMatch.productId) : products.find((item) => item.barcode === normalizedCode);
    if (product?.isActive) addProduct(product, unitMatch);
    else if (product) { setQuery(normalizedCode); setInactiveBarcodeProduct(product); }
    else if (allowProductCreation) { setQuery(normalizedCode); setUnknownBarcode(normalizedCode); }
    else { setNotice(`Barcode ${normalizedCode} is not registered. Ask an owner or admin to add it.`); }
  }, [products, productUnits, addProduct, allowProductCreation]);
  barcodeCallback.current = handleBarcode;

  useEffect(() => {
    let buffer = '';
    let lastKeyAt = 0;
    const onKey = (event: KeyboardEvent) => {
      const now = Date.now();
      if (now - lastKeyAt > 80) buffer = '';
      lastKeyAt = now;
      if (event.key === 'Enter' && buffer.length >= 4) { barcodeCallback.current(buffer); buffer = ''; return; }
      if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && now - lastKeyAt < 80) buffer += event.key;
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  function setProductQuantity(productId: string, requested: number, unitId: string | null = null) {
    setCart((current) => current.flatMap((line) => {
      if (line.product.id !== productId || (line.unit?.id ?? null) !== unitId) return [line];
      if (!Number.isFinite(requested)) return [line];
      if (!line.product.soldByWeight && !Number.isInteger(requested)) return [line];
      const step = productQuantityStep(line.product);
      const stepped = line.product.soldByWeight ? Math.round(requested / step) * step : requested;
      const quantity = normalizeQuantity(Math.min(line.product.stockQuantity, stepped));
      return quantity > 0 ? [{ ...line, quantity, pricingMode: 'quantity', enteredAmount: null }] : [];
    }));
    setCartIssues((current) => ({ ...current, [productId]: '' }));
  }

  function setPricingMode(productId: string, pricingMode: 'quantity' | 'amount', unitId: string | null = null) {
    const target = cart.find((line) => line.product.id === productId && (line.unit?.id ?? null) === unitId);
    const targetPrice = target?.unit?.sellingPrice ?? target?.product.sellingPrice ?? 0;
    if (pricingMode === 'amount' && target && (targetPrice <= 0 || Math.floor((target.product.stockBaseQuantity ?? target.product.stockQuantity) * targetPrice) <= 0)) {
      setCartIssues((issues) => ({ ...issues, [productId]: `${target.product.name} needs a selling price before it can be sold by amount.` }));
      return;
    }
    setCart((current) => current.map((line) => {
      if (line.product.id !== productId || (line.unit?.id ?? null) !== unitId) return line;
      if (pricingMode === 'amount') {
        return { ...line, pricingMode, enteredAmount: Math.max(1, Math.floor((line.unit?.sellingPrice ?? line.product.sellingPrice) * line.quantity)) };
      }
      const step = productQuantityStep(line.product);
      return { ...line, pricingMode, enteredAmount: null, quantity: normalizeQuantity(Math.max(step, Math.round(line.quantity / step) * step)) };
    }));
    setCartIssues((current) => ({ ...current, [productId]: '' }));
  }

  function setProductAmount(productId: string, enteredAmount: number, unitId: string | null = null) {
    const target = cart.find((line) => line.product.id === productId && (line.unit?.id ?? null) === unitId);
    if (!target) return;
    if (!Number.isInteger(enteredAmount) || enteredAmount <= 0) {
      setCartIssues((issues) => ({ ...issues, [productId]: 'Enter a peso amount above zero.' }));
      return;
    }
    const targetPrice = target.unit?.sellingPrice ?? target.product.sellingPrice;
    if (targetPrice <= 0) {
      setCartIssues((issues) => ({ ...issues, [productId]: `${target.product.name} needs a selling price before it can be sold by amount.` }));
      return;
    }
    const maximumAmount = Math.floor((target.product.stockBaseQuantity ?? target.product.stockQuantity) * targetPrice);
    if (enteredAmount > maximumAmount) {
      setCartIssues((issues) => ({ ...issues, [productId]: `Only ${formatQuantity(target.product.stockQuantity)} ${target.product.unit} available (up to ${formatPeso(maximumAmount)}).` }));
      return;
    }
    setCartIssues((issues) => ({ ...issues, [productId]: '' }));
    setCart((current) => current.map((line) => line.product.id === productId && (line.unit?.id ?? null) === unitId
      ? { ...line, pricingMode: 'amount', enteredAmount, quantity: normalizeQuantity(enteredAmount / targetPrice) }
      : line));
  }

  function switchLineUnit(productId: string, currentUnitId: string | null, nextUnit: ProductUnit) {
    setCart((current) => current.map((line) => line.product.id === productId && (line.unit?.id ?? null) === currentUnitId
      ? { ...line, unit: nextUnit, quantity: nextUnit.quantityStep, pricingMode: 'quantity', enteredAmount: null }
      : line));
  }

  return (
    <div className="sell-layout">
      <section className="product-pane">
        <div className="page-intro"><p className="eyebrow">FAST CHECKOUT</p><h1>What are we selling?</h1><p>Search, scan, or tap a favorite.</p></div>
        <div className="search-row">
          <label className="search-box"><Search /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search products…" autoComplete="off" /></label>
          <button className="scan-button" aria-label="Scan product barcode" onClick={() => setScanner(true)}><Camera /><span>Scan</span></button>
        </div>
        {notice && <div className="inline-notice">{notice}<button onClick={() => setNotice('')} aria-label="Dismiss"><X size={16} /></button></div>}
        {matching.length > 0 && <div className="search-results">{matching.map((product) => <ProductResult key={product.id} product={product} onAdd={() => addProduct(product)} />)}</div>}
        {!query && <><div className="section-title"><span>QUICK ITEMS</span><small>One tap to add</small></div><div className="quick-grid">{quickItems.map((product, index) => <button key={product.id} className={`quick-card tone-${index % 5}`} onClick={() => addProduct(product)}><ProductThumbnail product={product} className="quick-image" /><strong>{product.name}</strong><span>{formatPeso(product.sellingPrice)}{product.soldByWeight ? ` / ${product.unit}` : ''}</span><small>{formatQuantity(product.stockQuantity)} {product.unit}</small></button>)}</div></>}
      </section>
      {cartOpen && <button className="mobile-cart-backdrop" aria-label="Close cart" onClick={() => setCartOpen(false)} />}
      <aside className={`cart-pane ${cartOpen ? 'mobile-open' : ''}`} aria-label="Current sale">
        <div className="cart-heading"><div><p className="eyebrow">CURRENT SALE</p><h2>Cart <span>{cart.length}</span></h2></div><div className="cart-heading-actions">{cart.length > 0 && <button onClick={() => { setCart([]); setCartIssues({}); }}><Trash2 size={17} /> Clear</button>}<button className="icon-button mobile-cart-close" onClick={() => setCartOpen(false)} aria-label="Close cart"><X /></button></div></div>
        {cart.length === 0 ? <div className="empty-cart"><ShoppingBasket /><strong>Your cart is ready</strong><p>Add an item to begin a sale.</p></div> : <div className="cart-lines">{cart.map((line) => { const step = line.unit?.quantityStep ?? productQuantityStep(line.product); const units = unitsByProduct.get(line.product.id)?.filter((unit) => unit.isActive && unit.canSell) ?? []; const unitId = line.unit?.id ?? null; const price = line.unit?.sellingPrice ?? line.product.sellingPrice; return <div className={`cart-line ${line.product.soldByWeight ? 'weighted' : ''}`} key={`${line.product.id}:${unitId ?? 'legacy'}`}><div><strong>{line.product.name}</strong>{units.length > 1 ? <select aria-label={`${line.product.name} selling unit`} value={unitId ?? ''} onChange={(event) => { const next = units.find((unit) => unit.id === event.target.value); if (next) switchLineUnit(line.product.id, unitId, next); }}>{units.map((unit) => <option key={unit.id} value={unit.id}>{unit.name} · {formatPeso(unit.sellingPrice ?? 0)}</option>)}</select> : <span>{formatPeso(price)} / {line.unit?.name ?? line.product.unit}</span>}</div>{line.product.soldByWeight || line.unit?.allowAmountPricing ? <WeightedLineEditor line={{ ...line, product: { ...line.product, sellingPrice: price, unit: line.unit?.name ?? line.product.unit, quantityStep: line.unit?.quantityStep ?? line.product.quantityStep, soldByWeight: line.unit?.allowAmountPricing ?? line.product.soldByWeight } }} issue={cartIssues[line.product.id]} onModeChange={(mode) => setPricingMode(line.product.id, mode, unitId)} onWeightChange={(quantity) => setProductQuantity(line.product.id, quantity, unitId)} onAmountChange={(amount) => setProductAmount(line.product.id, amount, unitId)} /> : <div className="quantity-stepper"><button aria-label={`Decrease ${line.product.name}`} onClick={() => setProductQuantity(line.product.id, line.quantity - step, unitId)}><Minus /></button><strong>{line.quantity}</strong><button aria-label={`Increase ${line.product.name}`} onClick={() => setProductQuantity(line.product.id, line.quantity + step, unitId)}><Plus /></button></div>}<b>{formatPeso(lineSubtotal(line))}</b></div>; })}</div>}
        <div className="cart-total"><span>Total</span><strong>{formatPeso(total)}</strong><button className="checkout-button" disabled={!cart.length || hasCartIssues} onClick={() => { setCartOpen(false); setCheckout(true); }}>CHECKOUT <span>{formatPeso(total)}</span></button><small><Check /> Saved on this phone, even offline</small></div>
      </aside>
      <button className="mobile-cart-bar" disabled={!cart.length} onClick={() => setCartOpen(true)}><span><ShoppingBasket /> {cart.length} {cart.length === 1 ? 'product' : 'products'}</span><strong>{formatPeso(total)}</strong><ChevronDown /></button>
      {checkout && <CheckoutModal total={total} customers={customers} onClose={() => setCheckout(false)} onComplete={async (paymentMethod, cashReceived, customerId) => {
        const result = await completeSale({ cart, paymentMethod, cashReceived, customerId });
        setCart([]); setCartIssues({}); setCheckout(false); setNotice(`Sale completed${result.change ? ` · Change ${formatPeso(result.change)}` : ''}`);
      }} />}
      {scanner && <CameraScanner onCode={handleBarcode} onClose={() => setScanner(false)} suggestions={barcodeSuggestions} suggestionLabel="Product barcodes" />}
      {unknownBarcode && allowProductCreation && <ConfirmModal title="Barcode not found" description="No product is registered with this barcode. Would you like to add it now?" confirmLabel="Add product" onClose={() => setUnknownBarcode(null)} onConfirm={() => { const code = unknownBarcode; setUnknownBarcode(null); setNewProductBarcode(code); }}><p className="barcode-confirmation"><span>BARCODE</span><strong>{unknownBarcode}</strong></p></ConfirmModal>}
      {inactiveBarcodeProduct && <AlertModal title="Product is inactive" description={`${inactiveBarcodeProduct.name} already uses barcode ${inactiveBarcodeProduct.barcode}. Edit or reactivate it from Inventory instead of creating a duplicate.`} buttonLabel="Okay" onClose={() => setInactiveBarcodeProduct(null)} />}
      {newProductBarcode && <ProductForm product={null} productUnits={productUnits} initialBarcode={newProductBarcode} barcodeSuggestions={formBarcodeSuggestions} onClose={() => setNewProductBarcode(null)} onSaved={(product) => { setNewProductBarcode(null); if (product.stockQuantity > 0) { addProduct(product); setNotice(`${product.name} was saved and added to the cart.`); } else { setNotice(`${product.name} was saved with zero stock and was not added to the cart.`); } }} />}
    </div>
  );
}

function ProductResult({ product, onAdd }: { product: Product; onAdd: () => void }) {
  return <button onClick={onAdd}><ProductThumbnail product={product} /><span><strong>{product.name}</strong><small>{product.category} · {formatQuantity(product.stockQuantity)} {product.unit}</small></span><b>{formatPeso(product.sellingPrice)}{product.soldByWeight ? `/${product.unit}` : ''}</b><Plus /></button>;
}

function WeightedLineEditor({ line, issue, onModeChange, onWeightChange, onAmountChange }: {
  line: CartEntry; issue?: string; onModeChange: (mode: 'quantity' | 'amount') => void;
  onWeightChange: (quantity: number) => void; onAmountChange: (amount: number) => void;
}) {
  const mode = line.pricingMode ?? 'quantity';
  const [amountDraft, setAmountDraft] = useState(centavosToPesoInput(line.enteredAmount ?? Math.round(line.quantity * line.product.sellingPrice)));
  useEffect(() => {
    if (mode === 'amount') setAmountDraft(centavosToPesoInput(line.enteredAmount ?? Math.round(line.quantity * line.product.sellingPrice)));
  }, [mode]);
  const maximumAmount = Math.floor(line.product.stockQuantity * line.product.sellingPrice);
  return <div className="weighted-line-editor">
    <div className="weighted-mode-toggle" aria-label={`${line.product.name} entry mode`}>
      <button type="button" className={mode === 'quantity' ? 'active' : ''} aria-pressed={mode === 'quantity'} onClick={() => onModeChange('quantity')}>By weight</button>
      <button type="button" className={mode === 'amount' ? 'active' : ''} aria-pressed={mode === 'amount'} disabled={line.product.sellingPrice <= 0 || maximumAmount <= 0} onClick={() => onModeChange('amount')}>By amount</button>
    </div>
    {mode === 'quantity' ? <div className="quantity-stepper"><button aria-label={`Decrease ${line.product.name}`} onClick={() => onWeightChange(line.quantity - line.product.quantityStep)}><Minus /></button><WeightedQuantityInput product={line.product} quantity={line.quantity} onChange={onWeightChange} /><button aria-label={`Increase ${line.product.name}`} onClick={() => onWeightChange(line.quantity + line.product.quantityStep)}><Plus /></button></div> : <><label className="weighted-amount-input"><span>₱</span><input aria-label={`${line.product.name} sale amount`} type="number" min="0.01" max={maximumAmount / 100} step="0.01" inputMode="decimal" value={amountDraft} onChange={(event) => { const next = event.target.value; setAmountDraft(next); onAmountChange(pesoInputToCentavos(next)); }} /></label><small className="calculated-weight">{formatQuantity(line.quantity)} {line.product.unit} calculated</small></>}
    {issue && <small className="weighted-line-error" role="alert">{issue}</small>}
  </div>;
}

function WeightedQuantityInput({ product, quantity, onChange }: { product: Product; quantity: number; onChange: (quantity: number) => void }) {
  const [draft, setDraft] = useState(String(quantity));
  useEffect(() => setDraft(String(quantity)), [quantity]);
  const commit = () => {
    const parsed = Number(draft);
    if (Number.isFinite(parsed) && parsed > 0) onChange(parsed);
    else setDraft(String(quantity));
  };
  return <label><span className="visually-hidden">{`${product.name} quantity in ${product.unit}`}</span><input aria-label={`${product.name} quantity in ${product.unit}`} type="number" min={product.quantityStep} max={product.stockQuantity} step={product.quantityStep} inputMode="decimal" value={draft} onChange={(event) => { const next = event.target.value; setDraft(next); const parsed = Number(next); if (next && Number.isFinite(parsed) && parsed > 0) onChange(parsed); }} onBlur={commit} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); commit(); event.currentTarget.blur(); } }} /></label>;
}

export function CheckoutModal({ total, customers, onClose, onComplete }: {
  total: number; customers: Customer[]; onClose: () => void;
  onComplete: (method: PaymentMethod, cash: number | null, customerId: string | null) => Promise<void>;
}) {
  useModalBehavior(onClose);
  const [method, setMethod] = useState<PaymentMethod>('cash');
  const [cash, setCash] = useState(centavosToPesoInput(total));
  const [customerId, setCustomerId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const cashCentavos = pesoInputToCentavos(cash);
  const change = Math.max(0, cashCentavos - total);
  const canComplete = method !== 'cash' || cashCentavos >= total;

  return <div className="modal-backdrop"><div className="checkout-modal" role="dialog" aria-modal="true" aria-labelledby="checkout-title"><div className="modal-header"><button className="icon-button" onClick={onClose} aria-label="Back"><ChevronLeft /></button><span id="checkout-title">Complete sale</span><button className="icon-button" onClick={onClose} aria-label="Close checkout"><X /></button></div><div className="modal-scroll"><div className="checkout-amount"><span>TOTAL DUE</span><strong>{formatPeso(total)}</strong></div><div className="payment-grid">{(['cash', 'gcash', 'maya', 'utang'] as PaymentMethod[]).map((option) => <button key={option} type="button" className={method === option ? 'selected' : ''} onClick={() => { setMethod(option); setError(''); }}>{option === 'cash' ? <PhilippinePeso /> : option === 'utang' ? <ReceiptText /> : <CreditCard />}<span>{option.toUpperCase()}</span>{method === option && <Check className="payment-check" />}</button>)}</div>{method === 'cash' && <div className="cash-panel"><label>Cash received<div className="money-input"><span>₱</span><input type="number" min={total / 100} step="0.01" value={cash} onChange={(event) => setCash(event.target.value)} /></div></label><div className="cash-shortcuts">{[total, 10000, 20000, 50000].filter((value, index, values) => value >= total && values.indexOf(value) === index).slice(0, 4).map((value) => <button type="button" key={value} onClick={() => setCash(centavosToPesoInput(value))}>{value === total ? 'Exact' : formatPeso(value)}</button>)}</div><div className="change-row"><span>CHANGE</span><strong>{formatPeso(change)}</strong></div></div>}{method === 'utang' && <div className="cash-panel"><CustomerCombobox customers={customers} selectedId={customerId} onSelect={setCustomerId} onError={setError} /></div>}{method === 'maya' && <div className="manual-payment-note"><CreditCard /><span><strong>Manual confirmation</strong><small>Maya API is not connected yet. Confirm the payment in Maya before completing this sale.</small></span></div>}{error && <p className="form-message error">{error}</p>}</div><button className="complete-button" disabled={busy || !canComplete || (method === 'utang' && !customerId)} onClick={async () => { setBusy(true); setError(''); try { await onComplete(method, method === 'cash' ? cashCentavos : null, method === 'utang' ? customerId : null); } catch (caught) { setError(caught instanceof Error ? caught.message : 'Could not complete sale'); setBusy(false); } }}>{busy ? 'SAVING…' : 'COMPLETE SALE'} <span>{formatPeso(total)}</span></button></div></div>;
}

function CustomerCombobox({ customers, selectedId, onSelect, onError }: {
  customers: Customer[]; selectedId: string; onSelect: (id: string) => void; onError: (message: string) => void;
}) {
  const selected = customers.find((customer) => customer.id === selectedId);
  const [query, setQuery] = useState(selected?.name ?? '');
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const normalized = query.trim().toLocaleLowerCase();
  const matches = customers.filter((customer) => customer.isActive && [customer.name, customer.nickname, customer.phoneNumber]
    .some((value) => value?.toLocaleLowerCase().includes(normalized))).slice(0, 7);
  const exact = customers.find((customer) => customer.isActive && customer.name.trim().toLocaleLowerCase() === normalized);
  const canCreate = Boolean(normalized && !exact);
  const optionCount = matches.length + (canCreate ? 1 : 0);

  const choose = (customer: Customer) => {
    setQuery(customer.name); onSelect(customer.id); setOpen(false); onError('');
  };
  const add = async () => {
    if (!query.trim() || creating) return;
    if (exact) { choose(exact); return; }
    setCreating(true); onError('');
    try {
      const customer = await createCustomer(query);
      choose(customer);
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : 'Could not add customer');
    } finally { setCreating(false); }
  };

  return <div className="customer-combobox"><label htmlFor="checkout-customer">Customer</label><div className="combobox-input"><Search /><input id="checkout-customer" role="combobox" aria-expanded={open} aria-controls="customer-options" aria-autocomplete="list" value={query} placeholder="Search or add customer…" autoComplete="off" onFocus={() => setOpen(true)} onChange={(event) => { setQuery(event.target.value); onSelect(''); setOpen(true); setHighlighted(0); }} onKeyDown={(event) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); setOpen(true); setHighlighted((value) => Math.max(0, Math.min(optionCount - 1, value + 1))); }
    if (event.key === 'ArrowUp') { event.preventDefault(); setHighlighted((value) => Math.max(0, value - 1)); }
    if (event.key === 'Escape') setOpen(false);
    if (event.key === 'Enter' && open) { event.preventDefault(); if (highlighted < matches.length) choose(matches[highlighted]); else if (canCreate) void add(); }
  }} /><ChevronDown /></div>{open && <div id="customer-options" className="combobox-options" role="listbox">{matches.map((customer, index) => <button type="button" role="option" aria-selected={customer.id === selectedId} className={index === highlighted ? 'highlighted' : ''} key={customer.id} onMouseDown={(event) => event.preventDefault()} onClick={() => choose(customer)}><span className="avatar">{customer.name.charAt(0)}</span><span><strong>{customer.name}</strong><small>{[customer.nickname, customer.phoneNumber].filter(Boolean).join(' · ') || 'Customer'}</small></span>{customer.id === selectedId && <Check />}</button>)}{canCreate && <button type="button" className={`add-option ${highlighted === matches.length ? 'highlighted' : ''}`} onMouseDown={(event) => event.preventDefault()} onClick={() => void add()}><UserRoundPlus /><span><strong>{creating ? 'Adding…' : `Add “${query.trim()}”`}</strong><small>Create and use for this Utang sale</small></span></button>}{!matches.length && !canCreate && <p>Type a customer name to begin.</p>}</div>}</div>;
}

function LegacyInventoryView({ products, productUnits = [], inventoryMovements = [] }: { products: Product[]; productUnits?: ProductUnit[]; inventoryMovements?: InventoryMovement[] }) {
  const [showForm, setShowForm] = useState(false);
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<Product | null>(null);
  const [adjusting, setAdjusting] = useState<Product | null>(null);
  const [scanner, setScanner] = useState(false);
  const [restocking, setRestocking] = useState<Product | null>(null);
  const [unknownBarcode, setUnknownBarcode] = useState<string | null>(null);
  const [inactiveBarcodeProduct, setInactiveBarcodeProduct] = useState<Product | null>(null);
  const [newProductBarcode, setNewProductBarcode] = useState<string | null>(null);
  const barcodeSuggestions = useMemo(() => productBarcodeSuggestions(products, { includeInactive: true }), [products]);
  const formBarcodeSuggestions = useMemo(() => productBarcodeSuggestions(products), [products]);
  const filtered = products.filter((product) => product.name.toLowerCase().includes(query.toLowerCase()) || product.barcode?.includes(query));
  const lowStock = products.filter((product) => product.isActive && product.stockQuantity <= product.lowStockThreshold).length;
  const openAddProduct = (barcode: string | null = null) => {
    setEditing(null);
    setNewProductBarcode(barcode);
    setShowForm(true);
  };
  const openEditProduct = (product: Product) => {
    setEditing(product);
    setNewProductBarcode(null);
    setShowForm(true);
  };
  const handleRestockBarcode = (code: string) => {
    const normalizedCode = code.trim();
    if (!normalizedCode) return;
    const product = products.find((item) => item.barcode === normalizedCode);
    setScanner(false);
    if (!product) {
      setUnknownBarcode(normalizedCode);
      return;
    }
    if (!product.isActive) {
      setInactiveBarcodeProduct(product);
      return;
    }
    setRestocking(product);
  };
  return <section className="page-panel"><div className="page-header"><div><p className="eyebrow">STOCK CONTROL</p><h1>Inventory</h1><p>{products.length} products · <span className={lowStock ? 'warning-text' : ''}>{lowStock} low stock</span></p></div><div className="page-actions"><button className="secondary-button" onClick={() => setScanner(true)}><Camera /> Quick Restock</button><button className="primary-button" onClick={() => openAddProduct()}><Plus /> Add product</button></div></div><label className="search-box standalone"><Search /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search name or barcode…" /></label><div className="inventory-list">{filtered.map((product) => <article key={product.id} className="inventory-row"><ProductThumbnail product={product} /><div><strong>{product.name}</strong><small>{product.category} · {product.soldByWeight ? `Sold by weight · ${product.quantityStep} ${product.unit} step` : product.unit}{product.barcode ? ` · ${product.barcode}` : ''}</small></div><div className={product.stockQuantity <= product.lowStockThreshold ? 'stock-level low' : 'stock-level'}><strong>{formatQuantity(product.stockQuantity)}</strong><span>{product.unit} in stock</span></div><div className="inventory-price"><strong>{formatPeso(product.sellingPrice)}{product.soldByWeight ? `/${product.unit}` : ''}</strong><span>Cost {formatPeso(product.costPrice)}{product.soldByWeight ? `/${product.unit}` : ''}</span></div><button className="secondary-button compact" onClick={() => setAdjusting(product)}>Adjust</button><button className="icon-button" onClick={() => openEditProduct(product)} aria-label={`Edit ${product.name}`}><PackageOpen /></button></article>)}</div>{scanner && <CameraScanner onCode={handleRestockBarcode} onClose={() => setScanner(false)} suggestions={barcodeSuggestions} suggestionLabel="Inventory barcodes" />}{unknownBarcode && <ConfirmModal title="Barcode not found" description="No product is registered with this barcode. Would you like to add it now?" confirmLabel="Add product" onClose={() => setUnknownBarcode(null)} onConfirm={() => { const code = unknownBarcode; setUnknownBarcode(null); openAddProduct(code); }}><p className="barcode-confirmation"><span>BARCODE</span><strong>{unknownBarcode}</strong></p></ConfirmModal>}{inactiveBarcodeProduct && <ConfirmModal title="Product is inactive" description={`${inactiveBarcodeProduct.name} already uses barcode ${inactiveBarcodeProduct.barcode}. Edit or reactivate it before restocking.`} confirmLabel="Edit product" cancelLabel="Close" onClose={() => setInactiveBarcodeProduct(null)} onConfirm={() => { const product = inactiveBarcodeProduct; setInactiveBarcodeProduct(null); openEditProduct(product); }} />}{showForm && <ProductForm product={editing} productUnits={productUnits} initialBarcode={newProductBarcode ?? ''} barcodeSuggestions={editing ? productBarcodeSuggestions(products, { excludeProductId: editing.id }) : formBarcodeSuggestions} onClose={() => { setShowForm(false); setNewProductBarcode(null); }} />}{adjusting && <StockAdjustmentModal product={adjusting} onClose={() => setAdjusting(null)} onSave={(quantity) => adjustStock(adjusting, quantity, 'Manual stock adjustment')} />}{restocking && <QuickRestockModal product={restocking} onClose={() => setRestocking(null)} onSave={(mode, quantity) => restockProduct(restocking, mode, quantity)} />}</section>;
}

export function InventoryView(props: { products: Product[]; productUnits?: ProductUnit[]; inventoryMovements?: InventoryMovement[] }) {
  return <><LegacyInventoryView {...props} /><InventoryHistory products={props.products} productUnits={props.productUnits ?? []} movements={props.inventoryMovements ?? []} /></>;
}

function InventoryHistory({ products, productUnits, movements }: { products: Product[]; productUnits: ProductUnit[]; movements: InventoryMovement[] }) {
  const productMap = new Map(products.map((product) => [product.id, product]));
  const unitMap = new Map(productUnits.map((unit) => [unit.id, unit]));
  const recent = [...movements].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 20);
  return <section className="page-panel"><div className="page-header"><div><p className="eyebrow">AUDIT TRAIL</p><h2>Inventory history</h2><p>Receipts, counts, sales, and adjustments with unit snapshots.</p></div></div><div className="ledger-entries">{recent.length ? recent.map((movement) => { const product = productMap.get(movement.productId); const unit = movement.productUnitId ? unitMap.get(movement.productUnitId) : null; const amount = movement.inputQuantity ?? Math.abs(movement.quantityDelta); const symbol = movement.inputUnitSnapshot ?? unit?.symbol ?? product?.unit ?? ''; return <div key={movement.id}><span className={`ledger-kind ${movement.reason}`}>{movement.quantityDelta >= 0 ? '+' : '−'}</span><span><strong>{product?.name ?? 'Product'}</strong><small>{new Date(movement.createdAt).toLocaleString('en-PH')} · {movement.note ?? movement.reason} · {movement.actorDisplayNameSnapshot ?? 'Staff'}</small></span><b>{movement.quantityDelta >= 0 ? '+' : '−'}{formatQuantity(amount)} {symbol}</b></div>; }) : <div className="empty-cart"><ReceiptText /><strong>No inventory movements yet</strong><p>Stock activity will appear here.</p></div>}</div></section>;
}

function LegacyProductForm({ product, productUnits = [], onClose, initialBarcode = '', onSaved, barcodeSuggestions = [] }: { product: Product | null; productUnits?: ProductUnit[]; onClose: () => void; initialBarcode?: string; onSaved?: (product: Product) => void | Promise<void>; barcodeSuggestions?: BarcodeSuggestion[] }) {
  useModalBehavior(onClose);
  const [error, setError] = useState('');
  const [barcode, setBarcode] = useState(product?.barcode ?? initialBarcode);
  const [name, setName] = useState(product?.name ?? '');
  const [category, setCategory] = useState(product?.category || 'Other');
  const [unit, setUnit] = useState(product?.unit || 'piece');
  const [soldByWeight, setSoldByWeight] = useState(product?.soldByWeight ?? false);
  const [quantityStep, setQuantityStep] = useState(product?.quantityStep ?? 0.01);
  const existingBulk = productUnits.find((candidate) => candidate.productId === product?.id && candidate.isActive && candidate.multiplierBaseUnits > 1);
  const [bulkName, setBulkName] = useState(existingBulk?.name ?? '');
  const [bulkMultiplier, setBulkMultiplier] = useState(existingBulk?.multiplierBaseUnits ?? 24);
  const [bulkSellingPrice, setBulkSellingPrice] = useState(existingBulk?.sellingPrice ?? 0);
  const [bulkCostPrice, setBulkCostPrice] = useState(existingBulk?.costPrice ?? 0);
  const [bulkBarcode, setBulkBarcode] = useState(existingBulk?.barcode ?? '');
  const [scanner, setScanner] = useState(false);
  const [image, setImage] = useState<CompressedProductImage | null | undefined>(undefined);
  const [imageBusy, setImageBusy] = useState(false);
  const galleryRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);

  const buildUnits = (stockQuantity: number, lowStockThreshold: number, sellingPrice: number, costPrice: number): ProductUnitInput[] => {
    const existingBase = productUnits.find((candidate) => candidate.productId === product?.id && candidate.isBase);
    const existingSale = productUnits.find((candidate) => candidate.id === product?.defaultSaleUnitId);
    const normalizedUnit = unit.toLowerCase();
    const multiplier = soldByWeight && ['kg', 'kilogram', 'liter', 'litre'].includes(normalizedUnit) ? 1000 : 1;
    const baseName = multiplier === 1000 ? (['kg', 'kilogram'].includes(normalizedUnit) ? 'g' : 'milliliter') : unit;
    const baseId = existingBase?.id ?? crypto.randomUUID();
    const saleId = existingSale?.id ?? (multiplier === 1 ? baseId : crypto.randomUUID());
    const units: ProductUnitInput[] = [{ id: baseId, name: baseName, symbol: baseName, multiplierBaseUnits: 1, quantityStep: 1, canSell: multiplier === 1, canRestock: multiplier === 1, allowAmountPricing: false, sellingPrice: multiplier === 1 ? sellingPrice : null, costPrice: multiplier === 1 ? costPrice : null, barcode: multiplier === 1 ? (barcode.trim() || null) : null, isBase: true, isActive: true, replacesUnitId: null }];
    if (multiplier !== 1) units.push({ id: saleId, name: unit, symbol: unit, multiplierBaseUnits: multiplier, quantityStep, canSell: true, canRestock: true, allowAmountPricing: soldByWeight, sellingPrice, costPrice, barcode: barcode.trim() || null, isBase: false, isActive: true, replacesUnitId: null });
    if (bulkName.trim() && Number.isFinite(bulkMultiplier) && bulkMultiplier > 1) units.push({ id: existingBulk?.id ?? crypto.randomUUID(), name: bulkName.trim(), symbol: bulkName.trim(), multiplierBaseUnits: Math.round(bulkMultiplier), quantityStep: 1, canSell: true, canRestock: true, allowAmountPricing: false, sellingPrice: bulkSellingPrice, costPrice: bulkCostPrice, barcode: bulkBarcode.trim() || null, isBase: false, isActive: true, replacesUnitId: null });
    return units;
  };

  const chooseImage = async (file?: File) => {
    if (!file) return;
    setImageBusy(true); setError('');
    try { setImage(await compressProductImage(file)); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Could not process image'); }
    finally { setImageBusy(false); }
  };

  return <><div className="modal-backdrop"><form className="form-modal" role="dialog" aria-modal="true" aria-labelledby="product-form-title" onSubmit={async (event) => { event.preventDefault(); const values = new FormData(event.currentTarget); try { const saved = await saveProduct({ id: product?.id, name: values.get('name')!.toString(), category, barcode, costPrice: pesoInputToCentavos(values.get('costPrice')!.toString()), sellingPrice: pesoInputToCentavos(values.get('sellingPrice')!.toString()), stockQuantity: Number(values.get('stockQuantity')), unit, soldByWeight, quantityStep: soldByWeight ? quantityStep : 1, lowStockThreshold: Number(values.get('lowStockThreshold')), isQuickItem: values.get('isQuickItem') === 'on', image }); await onSaved?.(saved); onClose(); } catch (caught) { setError(caught instanceof Error ? caught.message : 'Could not save product'); } }}><div className="modal-header"><strong id="product-form-title">{product ? 'Edit product' : 'Add product'}</strong><button type="button" className="icon-button" onClick={onClose} aria-label="Close product form"><X /></button></div><div className="form-scroll"><section className="product-image-editor"><div>{image ? <BlobPreview image={image} name={name} /> : image === null || !product ? <span className="product-thumbnail image-preview"><ImageIcon /></span> : <ProductThumbnail product={product} className="image-preview" />}</div><div><strong>Product photo</strong><small>{image ? `${Math.ceil(image.blob.size / 1024)} KB · ${image.width}×${image.height}` : product?.imageRevision && image === undefined ? 'Saved photo' : 'Optional · compressed to 100 KB or less'}</small><div className="image-actions"><button type="button" className="secondary-button" disabled={imageBusy} onClick={() => cameraRef.current?.click()}><Camera /> Take photo</button><button type="button" className="secondary-button" disabled={imageBusy} onClick={() => galleryRef.current?.click()}><Upload /> Choose image</button>{((product?.imageRevision && image === undefined) || image) && <button type="button" className="image-remove" onClick={() => setImage(null)}><Trash2 /> Remove</button>}</div><input ref={cameraRef} className="visually-hidden" type="file" accept="image/*" capture="environment" onChange={(event) => { void chooseImage(event.target.files?.[0]); event.currentTarget.value = ''; }} /><input ref={galleryRef} className="visually-hidden" type="file" accept="image/*" onChange={(event) => { void chooseImage(event.target.files?.[0]); event.currentTarget.value = ''; }} /></div></section><div className="two-column-form"><label className="span-two">Product name<input name="name" value={name} onChange={(event) => setName(event.target.value)} required autoFocus /></label><SearchableDropdown label="Category" name="category" value={category} options={PRODUCT_CATEGORIES} onChange={setCategory} placeholder="Search categories…" required /><label>Barcode (optional)<div className="barcode-field"><input name="barcode" inputMode="numeric" value={barcode} onChange={(event) => setBarcode(event.target.value)} /><button type="button" className="secondary-button" onClick={() => setScanner(true)} aria-label="Scan product barcode"><Camera /> Scan</button></div></label><label>{soldByWeight ? `Cost price per ${unit}` : 'Cost price'}<input name="costPrice" type="number" min="0" step="0.01" defaultValue={product ? centavosToPesoInput(product.costPrice) : ''} required /></label><label>{soldByWeight ? `Selling price per ${unit}` : 'Selling price'}<input name="sellingPrice" type="number" min="0" step="0.01" defaultValue={product ? centavosToPesoInput(product.sellingPrice) : ''} required /></label><label>Stock quantity ({unit})<input name="stockQuantity" type="number" min="0" step={soldByWeight ? quantityStep : 1} inputMode={soldByWeight ? 'decimal' : 'numeric'} defaultValue={product?.stockQuantity ?? 0} required /></label><SearchableDropdown label="Unit" name="unit" value={unit} options={PRODUCT_UNITS} onChange={setUnit} placeholder="Search units…" required /><label className="span-two weighted-toggle"><input type="checkbox" checked={soldByWeight} onChange={(event) => { setSoldByWeight(event.target.checked); if (event.target.checked && !['kg', 'g'].includes(unit)) setUnit('kg'); }} /><span><strong>Sold by weight</strong><small>Allow decimal stock and cart quantities. Prices are per {unit}.</small></span></label>{soldByWeight && <label>Quantity step ({unit})<input aria-label={`Quantity step (${unit})`} type="number" min="0.001" step="0.001" value={quantityStep} onChange={(event) => setQuantityStep(Number(event.target.value))} inputMode="decimal" required /></label>}<label>Low-stock alert ({unit})<input name="lowStockThreshold" type="number" min="0" step={soldByWeight ? quantityStep : 1} inputMode={soldByWeight ? 'decimal' : 'numeric'} defaultValue={product?.lowStockThreshold ?? 5} required /></label><label className="checkbox-label"><input name="isQuickItem" type="checkbox" defaultChecked={product?.isQuickItem ?? true} /> Show in Quick Items</label></div>{error && <p className="form-message error">{error}</p>}</div><button className="primary-button form-save" disabled={imageBusy}>{imageBusy ? 'Compressing photo…' : 'Save product'}</button></form></div>{scanner && <CameraScanner onCode={(code) => { setBarcode(code); setScanner(false); }} onClose={() => setScanner(false)} suggestions={barcodeSuggestions} suggestionLabel="Product barcodes" />}</>;
}

export function ProductForm({ product, productUnits = [], onClose, initialBarcode = '', onSaved, barcodeSuggestions = [] }: { product: Product | null; productUnits?: ProductUnit[]; onClose: () => void; initialBarcode?: string; onSaved?: (product: Product) => void | Promise<void>; barcodeSuggestions?: BarcodeSuggestion[] }) {
  useModalBehavior(onClose);
  const existingBulk = productUnits.find((unit) => unit.productId === product?.id && unit.isActive && !unit.isBase && unit.multiplierBaseUnits > 1);
  const existingBase = productUnits.find((unit) => unit.productId === product?.id && unit.isBase);
  const [name, setName] = useState(product?.name ?? '');
  const [category, setCategory] = useState(product?.category ?? 'Other');
  const [barcode, setBarcode] = useState(product?.barcode ?? initialBarcode);
  const [unit, setUnit] = useState(product?.unit ?? 'piece');
  const [soldByWeight, setSoldByWeight] = useState(product?.soldByWeight ?? false);
  const [quantityStep, setQuantityStep] = useState(product?.quantityStep ?? 0.01);
  const [bulkName, setBulkName] = useState(existingBulk?.name ?? '');
  const [bulkMultiplier, setBulkMultiplier] = useState(existingBulk?.multiplierBaseUnits ?? 24);
  const [bulkSellingPrice, setBulkSellingPrice] = useState(existingBulk?.sellingPrice ?? 0);
  const [bulkCostPrice, setBulkCostPrice] = useState(existingBulk?.costPrice ?? 0);
  const [bulkBarcode, setBulkBarcode] = useState(existingBulk?.barcode ?? '');
  const [error, setError] = useState('');
  const [scanner, setScanner] = useState(false);
  const [image, setImage] = useState<CompressedProductImage | null | undefined>(undefined);
  const [imageBusy, setImageBusy] = useState(false);
  const galleryRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const chooseImage = async (file?: File) => {
    if (!file) return;
    setImageBusy(true); setError('');
    try { setImage(await compressProductImage(file)); } catch (caught) { setError(caught instanceof Error ? caught.message : 'Could not process image'); }
    finally { setImageBusy(false); }
  };
  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    try {
      const costPrice = pesoInputToCentavos(String(values.get('costPrice') ?? '0'));
      const sellingPrice = pesoInputToCentavos(String(values.get('sellingPrice') ?? '0'));
      const stockQuantity = Number(values.get('stockQuantity'));
      const lowStockThreshold = Number(values.get('lowStockThreshold'));
      const normalized = unit.toLowerCase();
      const multiplier = soldByWeight && ['kg', 'kilogram', 'liter', 'litre'].includes(normalized) ? 1000 : 1;
      const baseId = existingBase?.id ?? crypto.randomUUID();
      const saleId = product?.defaultSaleUnitId ?? (multiplier === 1 ? baseId : crypto.randomUUID());
      const units: ProductUnitInput[] = [{ id: baseId, name: multiplier === 1000 ? (['kg', 'kilogram'].includes(normalized) ? 'g' : 'milliliter') : unit, symbol: unit, multiplierBaseUnits: 1, quantityStep: 1, canSell: multiplier === 1, canRestock: multiplier === 1, allowAmountPricing: false, sellingPrice: multiplier === 1 ? sellingPrice : null, costPrice: multiplier === 1 ? costPrice : null, barcode: multiplier === 1 ? (barcode.trim() || null) : null, isBase: true, isActive: true, replacesUnitId: null }];
      if (multiplier !== 1) units.push({ id: saleId, name: unit, symbol: unit, multiplierBaseUnits: multiplier, quantityStep, canSell: true, canRestock: true, allowAmountPricing: soldByWeight, sellingPrice, costPrice, barcode: barcode.trim() || null, isBase: false, isActive: true, replacesUnitId: null });
      if (bulkName.trim() && bulkMultiplier > 1) units.push({ id: existingBulk?.id ?? crypto.randomUUID(), name: bulkName.trim(), symbol: bulkName.trim(), multiplierBaseUnits: Math.round(bulkMultiplier), quantityStep: 1, canSell: true, canRestock: true, allowAmountPricing: false, sellingPrice: bulkSellingPrice, costPrice: bulkCostPrice, barcode: bulkBarcode.trim() || null, isBase: false, isActive: true, replacesUnitId: null });
      const saleUnit = units.find((candidate) => candidate.id === saleId) ?? units.find((candidate) => candidate.canSell) ?? units[0];
      const saved = await saveProduct({ id: product?.id, name: name.trim(), category, barcode, costPrice, sellingPrice, stockQuantity, unit, soldByWeight, quantityStep: soldByWeight ? quantityStep : 1, lowStockThreshold, isQuickItem: product?.isQuickItem ?? true, units, stockBaseQuantity: Math.round(stockQuantity * multiplier), lowStockBaseThreshold: Math.round(lowStockThreshold * multiplier), defaultSaleUnitId: saleUnit?.id ?? null, defaultRestockUnitId: saleUnit?.id ?? null, displayUnitId: saleUnit?.id ?? null, image });
      await onSaved?.(saved); onClose();
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Could not save product'); }
  };
  return <><div className="modal-backdrop"><form className="form-modal" role="dialog" aria-modal="true" onSubmit={submit}><div className="modal-header"><strong>{product ? 'Edit product' : 'Add product'}</strong><button type="button" className="icon-button" onClick={onClose} aria-label="Close product form"><X /></button></div><div className="form-scroll"><section className="product-image-editor"><div><span className="product-thumbnail image-preview"><ImageIcon /></span></div><div><strong>Product photo</strong><small>Optional · compressed to 100 KB or less</small><div className="image-actions"><button type="button" className="secondary-button" disabled={imageBusy} onClick={() => cameraRef.current?.click()}><Camera /> Take photo</button><button type="button" className="secondary-button" disabled={imageBusy} onClick={() => galleryRef.current?.click()}><Upload /> Choose image</button><input ref={cameraRef} className="visually-hidden" type="file" accept="image/*" capture="environment" onChange={(event) => { void chooseImage(event.target.files?.[0]); event.currentTarget.value = ""; }} /><input ref={galleryRef} className="visually-hidden" type="file" accept="image/*" onChange={(event) => { void chooseImage(event.target.files?.[0]); event.currentTarget.value = ""; }} /></div></div></section><div className="two-column-form"><label className="span-two">Product name<input name="name" value={name} onChange={(event) => setName(event.target.value)} required autoFocus /></label><SearchableDropdown label="Category" name="category" value={category} options={PRODUCT_CATEGORIES} onChange={setCategory} placeholder="Search categories…" required /><label>Barcode (optional)<div className="barcode-field"><input name="barcode" value={barcode} onChange={(event) => setBarcode(event.target.value)} /><button type="button" className="secondary-button" onClick={() => setScanner(true)} aria-label="Scan product barcode"><Camera /> Scan</button></div></label><label>{soldByWeight ? `Cost price per ${unit}` : "Cost price"}<input name="costPrice" type="number" min="0" step="0.01" defaultValue={product ? centavosToPesoInput(product.costPrice) : ''} required /></label><label>{soldByWeight ? `Selling price per ${unit}` : "Selling price"}<input name="sellingPrice" type="number" min="0" step="0.01" defaultValue={product ? centavosToPesoInput(product.sellingPrice) : ''} required /></label><label>Stock quantity ({unit})<input name="stockQuantity" type="number" min="0" step={soldByWeight ? quantityStep : 1} defaultValue={product?.stockQuantity ?? 0} required /></label><SearchableDropdown label="Unit" name="unit" value={unit} options={PRODUCT_UNITS} onChange={setUnit} placeholder="Search units…" required /><label className="span-two weighted-toggle"><input type="checkbox" checked={soldByWeight} onChange={(event) => { setSoldByWeight(event.target.checked); if (event.target.checked && !['kg', 'g'].includes(unit)) setUnit('kg'); }} /><span><strong>Sold by weight</strong><small>Use canonical grams/milliliters for stock.</small></span></label>{soldByWeight && <label>Quantity step ({unit})<input type="number" min="0.001" step="0.001" value={quantityStep} onChange={(event) => setQuantityStep(Number(event.target.value))} /></label>}<label>Low-stock alert ({unit})<input name="lowStockThreshold" type="number" min="0" step={soldByWeight ? quantityStep : 1} defaultValue={product?.lowStockThreshold ?? 5} required /></label><div className="span-two"><strong>Bulk unit pricing (optional)</strong><small>Example: a case or sack can have its own price and barcode.</small></div><label>Bulk unit name<input value={bulkName} onChange={(event) => setBulkName(event.target.value)} placeholder="Case, sack…" /></label><label>Base units per bulk<input type="number" min="2" step="1" value={bulkMultiplier} onChange={(event) => setBulkMultiplier(Number(event.target.value))} /></label><label>Bulk selling price<input type="number" min="0" step="0.01" value={bulkSellingPrice / 100} onChange={(event) => setBulkSellingPrice(pesoInputToCentavos(event.target.value))} /></label><label>Bulk cost price<input type="number" min="0" step="0.01" value={bulkCostPrice / 100} onChange={(event) => setBulkCostPrice(pesoInputToCentavos(event.target.value))} /></label><label>Bulk barcode<input value={bulkBarcode} onChange={(event) => setBulkBarcode(event.target.value)} /></label></div>{error && <p className="form-message error">{error}</p>}</div><button className="primary-button form-save">Save product</button></form></div>{scanner && <CameraScanner onCode={(code) => { setBarcode(code); setScanner(false); }} onClose={() => setScanner(false)} suggestions={barcodeSuggestions} suggestionLabel="Product barcodes" />}</>;
}

export function UtangView({ customers, entries }: { customers: Customer[]; entries: UtangEntry[] }) {
  const activeCustomers = customers.filter((customer) => customer.isActive);
  const [selectedId, setSelectedId] = useState(activeCustomers[0]?.id ?? '');
  const [query, setQuery] = useState('');
  const [addingCustomer, setAddingCustomer] = useState(false);
  const [recordingPayment, setRecordingPayment] = useState(false);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredCustomers = activeCustomers.filter((customer) => !normalizedQuery || [customer.name, customer.nickname, customer.phoneNumber]
    .some((value) => value?.toLocaleLowerCase().includes(normalizedQuery)));
  const selected = activeCustomers.find((customer) => customer.id === selectedId) ?? activeCustomers[0];
  const selectedEntries = selected ? entries.filter((entry) => entry.customerId === selected.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)) : [];
  const balance = calculateUtangBalance(selectedEntries);
  return <section className="page-panel"><div className="page-header"><div><p className="eyebrow">CUSTOMER LEDGER</p><h1>Utang</h1><p>Balances are calculated from purchases and payments.</p></div><button className="primary-button" onClick={() => setAddingCustomer(true)}><UserRoundPlus /> Add customer</button></div><div className="ledger-layout"><div className="customer-sidebar"><label className="search-box ledger-search"><Search /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search customers…" autoComplete="off" /></label><aside className="customer-list">{filteredCustomers.length ? filteredCustomers.map((customer) => { const customerBalance = calculateUtangBalance(entries.filter((entry) => entry.customerId === customer.id)); return <button className={selected?.id === customer.id ? 'selected' : ''} key={customer.id} onClick={() => setSelectedId(customer.id)}><span className="avatar">{customer.name.charAt(0)}</span><span><strong>{customer.name}</strong><small>{customerBalance ? 'Has balance' : 'Paid up'}</small></span><b>{formatPeso(customerBalance)}</b></button>; }) : <div className="empty-cart customer-empty"><CircleUserRound /><strong>{activeCustomers.length ? 'No matching customers' : 'No customers yet'}</strong><p>{activeCustomers.length ? `No results for “${query.trim()}”.` : 'Add someone when they first use utang.'}</p>{query && <button className="secondary-button" onClick={() => setQuery('')}>Clear search</button>}<button className="primary-button" onClick={() => setAddingCustomer(true)}><UserRoundPlus /> Add customer</button></div>}</aside></div><div className="ledger-card">{selected ? <><div className="ledger-header"><div><span>CURRENT BALANCE</span><strong>{formatPeso(balance)}</strong><p>{selected.name}</p></div><button className="secondary-button" disabled={balance <= 0} onClick={() => setRecordingPayment(true)}><PhilippinePeso /> Record payment</button></div><div className="ledger-entries">{selectedEntries.length ? selectedEntries.map((entry) => <div key={entry.id}><span className={`ledger-kind ${entry.kind}`}>{entry.kind === 'payment' ? '−' : '+'}</span><span><strong>{entry.kind === 'payment' ? 'Payment' : 'Purchase'}</strong><small>{new Date(entry.createdAt).toLocaleString('en-PH')} · {entry.note}</small></span><b className={entry.kind === 'payment' ? 'payment' : ''}>{entry.kind === 'payment' ? '−' : '+'}{formatPeso(entry.amount)}</b></div>) : <div className="empty-cart"><ReceiptText /><strong>No ledger entries</strong><p>Utang purchases and payments appear here.</p></div>}</div></> : <div className="empty-cart"><CircleUserRound /><strong>Choose a customer</strong></div>}</div></div>{addingCustomer && <AddCustomerModal initialName={query.trim()} onClose={() => setAddingCustomer(false)} onSave={async (name) => { const customer = await createCustomer(name); setSelectedId(customer.id); setQuery(''); return customer; }} />}{recordingPayment && selected && <RecordPaymentModal customer={selected} balance={balance} onClose={() => setRecordingPayment(false)} onSave={(amount) => recordUtangPayment(selected.id, amount)} />}</section>;
}

function ReportsView({ data }: { data: StoreData }) {
  const today = localDateKey(new Date());
  const sales = data.sales.filter((sale) => localDateKey(new Date(sale.createdAt)) === today);
  const saleIds = new Set(sales.map((sale) => sale.id));
  const items = data.saleItems.filter((item) => saleIds.has(item.saleId));
  const expenses = data.expenses.filter((expense) => localDateKey(new Date(expense.occurredAt)) === today);
  const summary = calculateDailySummary(sales, items, expenses);
  const topProducts = Object.entries(items.reduce<Record<string, number>>((totals, item) => { totals[item.productNameSnapshot] = (totals[item.productNameSnapshot] ?? 0) + item.quantity; return totals; }, {})).sort((a, b) => b[1] - a[1]).slice(0, 5);
  return <section className="page-panel"><div className="page-header"><div><p className="eyebrow">TODAY · {new Date().toLocaleDateString('en-PH', { month: 'long', day: 'numeric' }).toUpperCase()}</p><h1>Daily summary</h1><p>A simple view of how the store is doing.</p></div></div><div className="metric-grid"><Metric label="Sales" value={formatPeso(summary.sales)} accent="green" icon={<PhilippinePeso />} /><Metric label="Gross profit" value={formatPeso(summary.grossProfit)} accent="yellow" icon={<BarChart3 />} /><Metric label="Expenses" value={formatPeso(summary.expenses)} accent="red" icon={<ReceiptText />} /><Metric label="Transactions" value={String(summary.transactions)} accent="blue" icon={<ShoppingBasket />} /></div><div className="report-grid"><section className="report-card"><div className="section-heading"><div><p className="eyebrow">PAYMENTS</p><h2>Sales breakdown</h2></div></div>{(['cash', 'gcash', 'maya', 'utang', 'other'] as const).map((method) => <div className="report-row" key={method}><span>{method.toUpperCase()}</span><strong>{formatPeso(summary.paymentBreakdown[method] ?? 0)}</strong></div>)}</section><section className="report-card"><div className="section-heading"><div><p className="eyebrow">MOST SOLD</p><h2>Top products</h2></div></div>{topProducts.length ? topProducts.map(([name, quantity], index) => <div className="report-row" key={name}><span><b className="rank">{index + 1}</b>{name}</span><strong>{quantity} sold</strong></div>) : <div className="empty-cart compact-empty"><PackageOpen /><p>Products appear after the first sale today.</p></div>}</section></div></section>;
}

function Metric({ label, value, accent, icon }: { label: string; value: string; accent: string; icon: React.ReactNode }) { return <article className={`metric-card ${accent}`}><div>{icon}<span>{label}</span></div><strong>{value}</strong></article>; }

export function MoreView({ expenses, session, onLogout }: {
  expenses: Expense[];
  session: StoreAuthSession;
  onLogout: () => Promise<void>;
}) {
  const canManageStore = isManagerRole(session.user.role);
  const [message, setMessage] = useState('');
  const [managerAccessMessage, setManagerAccessMessage] = useState('');
  const [confirmLocalRemoval, setConfirmLocalRemoval] = useState(false);
  const managerAccessDenied = Boolean(managerAccessMessage);

  const handleManagerAccessDenied = (nextMessage: string) => {
    setManagerAccessMessage(nextMessage);
  };

  if (!canManageStore) {
    return <section className="page-panel"><div className="page-header"><div><p className="eyebrow">SESSION</p><h1>Account</h1><p>Signed in to a shared store device.</p></div></div><div className="more-grid"><section className="settings-card"><div className="section-heading"><div><p className="eyebrow">ACTIVE USER</p><h2>{session.user.displayName}</h2></div><Cloud /></div><div className="backup-status"><span>Role</span><strong>{session.user.role.toUpperCase()}</strong><span>{session.user.staffCode || session.user.email || 'Shared browser session'}</span></div><div className="backup-status"><span>Store</span><strong>{session.store.name}</strong><span>Browser cache remains available after the first sync.</span></div><button className="danger-button" onClick={() => void onLogout()}><LogOut size={18} /> End cashier shift</button></section></div></section>;
  }

  return <><section className="page-panel"><div className="page-header"><div><p className="eyebrow">STORE TOOLS</p><h1>More</h1><p>Expenses, backups, staff access, and recovery operations.</p></div></div>{managerAccessMessage && <p className="form-message error" role="alert">{managerAccessMessage}</p>}<div className="more-grid"><section className="settings-card"><div className="section-heading"><div><p className="eyebrow">STORE COSTS</p><h2>Record expense</h2></div><ReceiptText /></div><form className="stack-form" onSubmit={async (event) => { event.preventDefault(); const form = event.currentTarget; const values = new FormData(form); setMessage(''); try { await recordExpense({ category: values.get('category')!.toString(), description: values.get('description')!.toString(), amount: pesoInputToCentavos(values.get('amount')!.toString()), occurredAt: new Date().toISOString() }); form.reset(); setMessage('Expense saved.'); } catch (error) { if (isManagerAccessDenied(error)) { handleManagerAccessDenied(error instanceof Error ? error.message : 'You do not have access to this action'); return; } setMessage(error instanceof Error ? error.message : 'Could not save expense'); } }}><label>Category<select name="category" disabled={managerAccessDenied}><option>Store supplies</option><option>Transportation</option><option>Utilities</option><option>Delivery</option><option>Repairs</option><option>Miscellaneous</option></select></label><label>Description<input name="description" placeholder="Plastic bags, delivery fare…" required disabled={managerAccessDenied} /></label><label>Amount<input name="amount" type="number" min="0.01" step="0.01" required disabled={managerAccessDenied} /></label><button className="primary-button" disabled={managerAccessDenied}><Plus /> Save expense</button>{message && <p className="form-message">{message}</p>}</form><div className="recent-expenses"><strong>Recent expenses</strong>{expenses.slice().sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)).slice(0, 4).map((expense) => <div key={expense.id}><span>{expense.description}<small>{expense.category}</small></span><b>{formatPeso(expense.amount)}</b></div>)}</div></section><BackupPanel disabled={managerAccessDenied} onAccessDenied={handleManagerAccessDenied} /><StaffPanel disabled={managerAccessDenied} onAccessDenied={handleManagerAccessDenied} /><section className="settings-card"><div className="section-heading"><div><p className="eyebrow">SESSION</p><h2>Current access</h2></div><Cloud /></div><div className="backup-status"><span>Signed in as</span><strong>{session.user.displayName}</strong><span>{session.user.role.toUpperCase()} · {session.user.email || session.user.staffCode || 'Shared browser session'}</span></div><button className="danger-button" onClick={() => void onLogout()}><LogOut size={18} /> Sign out</button>{session.user.role === 'owner' && <div className="restore-box"><p className="muted">Signing out keeps offline sales on this device. Only use local-data removal when this browser is being retired or reset.</p><button className="danger-button" onClick={() => setConfirmLocalRemoval(true)}><Trash2 size={18} /> Remove this device’s local data</button></div>}</section></div></section>{confirmLocalRemoval && <ConfirmModal title="Remove local device data?" description="This permanently removes cached products, sales, pending sync commands, and images from this browser. Confirm that all sales are synchronized first." confirmLabel="Remove local data" tone="danger" onClose={() => setConfirmLocalRemoval(false)} onConfirm={async () => { await removeLocalStoreData(); setConfirmLocalRemoval(false); await onLogout(); }} />}</>;
}

function localDateKey(value: Date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).format(value);
}
