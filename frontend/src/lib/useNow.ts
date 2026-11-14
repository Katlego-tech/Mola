import { useEffect, useState } from 'react';

/** The current time, re-read every `everyMs` while mounted; drives countdowns only. */
export function useNow(everyMs = 250): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);
  return now;
}

/** Milliseconds left until a server deadline, corrected for this device's clock: the server's
 *  own time when the message was built, plus how long ago it arrived here (realtime.md 3). */
export function remainingMs(deadline: number, serverTime: number, receivedAt: number, now: number): number {
  return deadline - (serverTime + (now - receivedAt));
}
