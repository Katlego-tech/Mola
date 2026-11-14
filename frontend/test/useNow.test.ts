import { describe, expect, it } from 'vitest';
import { remainingMs } from '../src/lib/useNow';

describe('remainingMs', () => {
  const serverTime = 1_800_000_000_000;

  it('counts from the server clock, not the phone clock', () => {
    // The phone's clock is 3 minutes fast: it received the message "at" serverTime + 180 s.
    const receivedAt = serverTime + 180_000;
    expect(remainingMs(serverTime + 120_000, serverTime, receivedAt, receivedAt)).toBe(120_000);
  });

  it('subtracts the time elapsed since the message arrived', () => {
    const receivedAt = 5_000;
    expect(remainingMs(serverTime + 120_000, serverTime, receivedAt, receivedAt + 30_000)).toBe(90_000);
  });

  it('goes negative once the deadline has passed', () => {
    expect(remainingMs(serverTime + 1_000, serverTime, 0, 2_000)).toBe(-1_000);
  });
});
