import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export function hashSecret(secret: string) {
  const salt = randomBytes(16).toString('hex');
  const derived = scryptSync(secret, salt, 64).toString('hex');
  return `scrypt:${salt}:${derived}`;
}

export function verifySecret(secret: string, stored: string | null | undefined) {
  if (!stored) return false;
  const [algorithm, salt, derived] = stored.split(':');
  if (algorithm !== 'scrypt' || !salt || !derived) return false;
  const actual = scryptSync(secret, salt, 64);
  const expected = Buffer.from(derived, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
