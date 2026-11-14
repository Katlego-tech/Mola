import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';

// A ticket is held by a random secret kept on the patron's phone. Only its SHA-256 is stored,
// so a leaked table row cannot be used to confirm, resume or cancel someone else's ticket.

const HASH_HEX = /^[0-9a-f]{64}$/;

function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

export function issueSecret(): { secret: string; secretHash: string } {
  const secret = randomUUID();
  return { secret, secretHash: sha256(secret).toString('hex') };
}

export function verifySecret(presented: string, secretHash: string): boolean {
  if (presented.length === 0 || !HASH_HEX.test(secretHash)) return false;
  return timingSafeEqual(sha256(presented), Buffer.from(secretHash, 'hex'));
}
