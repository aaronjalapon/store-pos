import { z } from 'zod';

export const roles = ['superadmin', 'owner', 'admin', 'cashier'] as const;
export type Role = (typeof roles)[number];
export type StoreRole = Exclude<Role, 'superadmin'>;

export const paymentMethods = ['cash', 'gcash', 'maya', 'utang', 'other'] as const;
export type PaymentMethod = (typeof paymentMethods)[number];

export const inventoryMovementReasons = ['sale', 'restock', 'adjustment', 'void'] as const;
export type InventoryMovementReason = (typeof inventoryMovementReasons)[number];

export const commandStatuses = ['applied', 'conflict'] as const;
export type CommandStatus = (typeof commandStatuses)[number];

export const commandConflictReasons = [
  'stale_product',
  'stale_customer',
  'not_found',
  'inactive',
  'permission_denied',
  'device_not_bootstrapped',
  'validation_failed',
  'unknown',
] as const;
export type CommandConflictReason = (typeof commandConflictReasons)[number];

export interface StoreInfo {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface DeviceInfo {
  id: string;
  storeId: string;
  name: string;
  firstSyncedAt: string | null;
  lastSeenAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionUser {
  id: string;
  displayName: string;
  email: string | null;
  staffCode: string | null;
  role: Role;
}

export interface StoreAuthSession {
  token: string;
  store: StoreInfo;
  device: DeviceInfo;
  user: SessionUser & { role: StoreRole };
}

export interface SuperadminAuthSession {
  token: string;
  store: null;
  device: null;
  user: SessionUser & { role: 'superadmin'; email: string };
}

export type AuthSession = StoreAuthSession | SuperadminAuthSession;

export interface RecordBase {
  id: string;
  storeId: string;
  createdAt: string;
  updatedAt: string;
  recordVersion: number;
}

export interface Product extends RecordBase {
  barcode: string | null;
  sku: string | null;
  imageRevision: string | null;
  name: string;
  category: string;
  costPrice: number;
  sellingPrice: number;
  stockQuantity: number;
  unit: string;
  soldByWeight: boolean;
  quantityStep: number;
  lowStockThreshold: number;
  isQuickItem: boolean;
  isActive: boolean;
}

export interface Sale extends RecordBase {
  transactionNumber: string;
  customerId: string | null;
  cashierUserId: string;
  deviceId: string;
  subtotal: number;
  discount: number;
  total: number;
  paymentMethod: PaymentMethod;
  cashReceived: number | null;
  changeAmount: number | null;
}

export interface SaleItem extends RecordBase {
  saleId: string;
  productId: string;
  productNameSnapshot: string;
  quantity: number;
  unitPrice: number;
  costPriceSnapshot: number;
  subtotal: number;
}

export interface InventoryMovement extends RecordBase {
  productId: string;
  saleId: string | null;
  reason: InventoryMovementReason;
  quantityDelta: number;
  stockAfter: number;
  note: string | null;
  actorUserId: string;
  deviceId: string;
}

export interface Customer extends RecordBase {
  name: string;
  nickname: string | null;
  phoneNumber: string | null;
  notes: string | null;
  isActive: boolean;
}

export interface UtangEntry extends RecordBase {
  customerId: string;
  saleId: string | null;
  kind: 'purchase' | 'payment' | 'adjustment';
  amount: number;
  note: string | null;
  actorUserId: string;
}

export interface Expense extends RecordBase {
  category: string;
  description: string;
  amount: number;
  occurredAt: string;
  actorUserId: string;
}

export interface ProductImageMetadata {
  productId: string;
  revision: string;
  contentType: 'image/webp' | 'image/jpeg';
  byteLength: number;
  updatedAt: string;
}

export interface StaffMember {
  id: string;
  displayName: string;
  email: string | null;
  staffCode: string | null;
  role: Role;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SuperadminStoreSummary {
  id: string;
  name: string;
  ownerCount: number;
  adminCount: number;
  cashierCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface StoreSnapshot {
  products: Product[];
  sales: Sale[];
  saleItems: SaleItem[];
  inventoryMovements: InventoryMovement[];
  customers: Customer[];
  utangEntries: UtangEntry[];
  expenses: Expense[];
  staff: StaffMember[];
}

export interface StoreSyncResponse {
  cursor: number;
  snapshot: StoreSnapshot;
}

export interface StoreBootstrapResponse extends StoreSyncResponse {
  session: AuthSession;
}

export const setupOwnerSchema = z.object({
  storeName: z.string().trim().min(2).max(120),
  displayName: z.string().trim().min(2).max(120),
  email: z.email(),
  password: z.string().min(8).max(200),
  deviceId: z.string().uuid(),
  deviceName: z.string().trim().min(1).max(80),
});
export type SetupOwnerRequest = z.infer<typeof setupOwnerSchema>;

export interface SetupStatusResponse {
  needsSetup: boolean;
}

export const ownerLoginSchema = z.object({
  email: z.email(),
  password: z.string().min(8).max(200),
  deviceId: z.string().uuid(),
  deviceName: z.string().trim().min(1).max(80),
});
export type OwnerLoginRequest = z.infer<typeof ownerLoginSchema>;

export const cashierLoginSchema = z.object({
  storeId: z.string().uuid(),
  staffCode: z.string().trim().min(3).max(32),
  pin: z.string().trim().min(4).max(32),
  deviceId: z.string().uuid(),
  deviceName: z.string().trim().min(1).max(80),
});
export type CashierLoginRequest = z.infer<typeof cashierLoginSchema>;

export const superadminCreateStoreSchema = z.object({
  storeName: z.string().trim().min(2).max(120),
  ownerDisplayName: z.string().trim().min(2).max(120),
  ownerEmail: z.email(),
  ownerPassword: z.string().min(8).max(200),
});
export type SuperadminCreateStoreRequest = z.infer<typeof superadminCreateStoreSchema>;

export const superadminStaffInputSchema = z.discriminatedUnion('role', [
  z.object({
    role: z.literal('owner'),
    displayName: z.string().trim().min(2).max(120),
    email: z.email(),
    password: z.string().min(8).max(200),
  }),
  z.object({
    role: z.literal('admin'),
    displayName: z.string().trim().min(2).max(120),
    email: z.email(),
    password: z.string().min(8).max(200),
  }),
]);
export type SuperadminStaffInput = z.infer<typeof superadminStaffInputSchema>;

export interface SuperadminStoreListResponse {
  stores: SuperadminStoreSummary[];
}

export interface SuperadminStoreMutationResponse {
  store: SuperadminStoreSummary;
  staff: StaffMember;
}

export interface AuthSessionResponse {
  session: AuthSession;
}

export interface LogoutResponse {
  loggedOut: true;
}

export const adminStaffInputSchema = z.object({
  role: z.literal('admin'),
  displayName: z.string().trim().min(2).max(120),
  email: z.email(),
  password: z.string().min(8).max(200),
});

export const cashierStaffInputSchema = z.object({
  role: z.literal('cashier'),
  displayName: z.string().trim().min(2).max(120),
  staffCode: z.string().trim().min(3).max(32),
  pin: z.string().trim().min(4).max(32),
});

export const createStaffSchema = z.discriminatedUnion('role', [adminStaffInputSchema, cashierStaffInputSchema]);
export type CreateStaffRequest = z.infer<typeof createStaffSchema>;

export interface StaffListResponse {
  staff: StaffMember[];
}

export interface StaffMutationResponse {
  staff: StaffMember;
}

export const resetStaffSecretSchema = z.object({
  password: z.string().min(8).max(200).optional(),
  pin: z.string().trim().min(4).max(32).optional(),
});
export type ResetStaffSecretRequest = z.infer<typeof resetStaffSecretSchema>;

const zIso = z.iso.datetime();

export const saveProductCommandSchema = z.object({
  type: z.literal('saveProduct'),
  expectedVersion: z.number().int().positive().nullable().optional(),
  payload: z.object({
    id: z.string().uuid().optional(),
    barcode: z.string().trim().min(1).max(64).optional().nullable(),
    imageRevision: z.string().uuid().nullable().optional(),
    name: z.string().trim().min(1).max(160),
    category: z.string().trim().min(1).max(80),
    costPrice: z.number().int().min(0),
    sellingPrice: z.number().int().min(0),
    stockQuantity: z.number().min(0),
    unit: z.string().trim().min(1).max(40),
    soldByWeight: z.boolean().default(false),
    quantityStep: z.number().positive().default(1),
    lowStockThreshold: z.number().min(0),
    isQuickItem: z.boolean(),
    isActive: z.boolean().default(true),
  }),
});

export const completeSaleCommandSchema = z.object({
  type: z.literal('completeSale'),
  payload: z.object({
    saleId: z.string().uuid(),
    transactionNumber: z.string().trim().min(1).max(64),
    occurredAt: zIso,
    paymentMethod: z.enum(paymentMethods),
    cashReceived: z.number().int().min(0).nullable(),
    customerId: z.string().uuid().nullable(),
    cart: z.array(z.object({
      productId: z.string().uuid(),
      quantity: z.number().positive(),
      pricingMode: z.enum(['quantity', 'amount']).optional(),
      enteredAmount: z.number().int().positive().nullable().optional(),
      expectedVersion: z.number().int().positive(),
    })).min(1),
  }),
});

export const adjustStockCommandSchema = z.object({
  type: z.literal('adjustStock'),
  payload: z.object({
    productId: z.string().uuid(),
    newQuantity: z.number().min(0),
    note: z.string().trim().max(200).default('Manual stock adjustment'),
    expectedVersion: z.number().int().positive(),
  }),
});

export const restockProductCommandSchema = z.object({
  type: z.literal('restockProduct'),
  payload: z.object({
    productId: z.string().uuid(),
    mode: z.enum(['add', 'set']),
    quantity: z.number().positive(),
    note: z.string().trim().max(200).default('Quick restock'),
    expectedVersion: z.number().int().positive(),
  }),
});

export const createCustomerCommandSchema = z.object({
  type: z.literal('createCustomer'),
  payload: z.object({
    name: z.string().trim().min(1).max(120),
  }),
});

export const recordUtangPaymentCommandSchema = z.object({
  type: z.literal('recordUtangPayment'),
  payload: z.object({
    customerId: z.string().uuid(),
    amount: z.number().int().positive(),
    note: z.string().trim().max(200).default('Payment received'),
    expectedVersion: z.number().int().positive().optional(),
  }),
});

export const recordExpenseCommandSchema = z.object({
  type: z.literal('recordExpense'),
  payload: z.object({
    category: z.string().trim().min(1).max(120),
    description: z.string().trim().min(1).max(200),
    amount: z.number().int().positive(),
    occurredAt: zIso,
  }),
});

export const storeCommandSchema = z.discriminatedUnion('type', [
  saveProductCommandSchema,
  completeSaleCommandSchema,
  adjustStockCommandSchema,
  restockProductCommandSchema,
  createCustomerCommandSchema,
  recordUtangPaymentCommandSchema,
  recordExpenseCommandSchema,
]);
export type StoreCommand = z.infer<typeof storeCommandSchema>;

export const storeCommandRequestSchema = z.object({
  clientCommandId: z.string().uuid(),
  baseCursor: z.number().int().nonnegative(),
  command: storeCommandSchema,
});
export type StoreCommandRequest = z.infer<typeof storeCommandRequestSchema>;

export interface CommandAppliedResponse {
  status: 'applied';
  cursor: number;
  snapshot: StoreSnapshot;
  message?: string;
  saleId?: string;
}

export interface CommandConflictResponse {
  status: 'conflict';
  reason: CommandConflictReason;
  cursor: number;
  message: string;
  snapshot: StoreSnapshot;
}

export type StoreCommandResponse = CommandAppliedResponse | CommandConflictResponse;

export interface BackupSummary {
  latestBackupAt: string | null;
  backupCount: number;
}

export interface LegacyImportRequest {
  snapshot: StoreSnapshot;
}
