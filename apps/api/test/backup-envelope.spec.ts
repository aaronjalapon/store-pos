import { BadRequestException } from '@nestjs/common';
import { decryptSnapshot, encryptSnapshot, parseBackupKeys } from '../src/backups/backup-envelope';

const snapshot = {
  products: [], productUnits: [], sales: [], saleItems: [], inventoryMovements: [],
  customers: [], utangEntries: [], expenses: [], staff: [], qrPayments: [], paymentSettings: null,
};

describe('encrypted backup envelope', () => {
  const key = Buffer.alloc(32, 7);
  const input = { storeId: 'store-a', schemaVersion: 3, createdAt: '2026-10-03T00:00:00.000Z', snapshot, keyId: 'key-a', key };

  it('round-trips a gzip-compressed AES-GCM snapshot', () => {
    const attachments = [{
      kind: 'product_image' as const,
      productId: 'product-a',
      revision: 'revision-a',
      contentType: 'image/webp',
      byteLength: 3,
      checksumSha256: 'checksum',
      bodyBase64: Buffer.from('img').toString('base64'),
    }];
    const body = encryptSnapshot({ ...input, attachments });
    expect(Buffer.from(body).toString()).not.toContain('products');
    const decrypted = decryptSnapshot(body, { 'key-a': key }, 'store-a');
    expect(decrypted.snapshot).toEqual(snapshot);
    expect(decrypted.attachments).toEqual(attachments);
  });

  it('rejects tampering, wrong stores, and unavailable rotation keys', () => {
    const body = encryptSnapshot(input);
    const envelope = JSON.parse(body.toString()) as { ciphertext: string };
    envelope.ciphertext = `${envelope.ciphertext.slice(0, -2)}AA`;
    expect(() => decryptSnapshot(Buffer.from(JSON.stringify(envelope)), { 'key-a': key }, 'store-a')).toThrow(BadRequestException);
    expect(() => decryptSnapshot(body, { 'key-a': key }, 'store-b')).toThrow('another store');
    expect(() => decryptSnapshot(body, { 'key-b': Buffer.alloc(32, 8) }, 'store-a')).toThrow('unavailable');
  });

  it('fails closed for missing production key configuration', () => {
    expect(() => parseBackupKeys(undefined, undefined, true)).toThrow('required');
  });
});
