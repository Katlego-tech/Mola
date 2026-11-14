import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { issueSecret, verifySecret } from '../src/lib/secret';

describe('ticket secrets', () => {
  it('issues a UUID secret and stores only its SHA-256 hex', () => {
    const { secret, secretHash } = issueSecret();
    expect(secret).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(secretHash).toBe(createHash('sha256').update(secret).digest('hex'));
    expect(secretHash).not.toContain(secret);
  });

  it('issues a different secret every time', () => {
    expect(issueSecret().secret).not.toBe(issueSecret().secret);
  });

  it('verifies the secret it issued', () => {
    const { secret, secretHash } = issueSecret();
    expect(verifySecret(secret, secretHash)).toBe(true);
  });

  it('refuses a wrong secret', () => {
    const { secretHash } = issueSecret();
    expect(verifySecret(issueSecret().secret, secretHash)).toBe(false);
  });

  it('refuses an empty secret', () => {
    const { secretHash } = issueSecret();
    expect(verifySecret('', secretHash)).toBe(false);
  });

  it('refuses a malformed stored hash instead of throwing', () => {
    const { secret, secretHash } = issueSecret();
    expect(verifySecret(secret, secretHash.slice(1))).toBe(false);
    expect(verifySecret(secret, 'z'.repeat(64))).toBe(false);
  });
});
