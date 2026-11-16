import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { OfficeSnapshot, Ticket } from '../src/lib/model';
import { dayStats } from '../src/lib/stats';

const now = Date.parse('2026-11-16T12:00:00Z');
const zone = 'Africa/Johannesburg';
const snapshot = (tickets: Ticket[]): OfficeSnapshot => ({ readAt: 1000, office: null, tickets, screens: [] });
function ticket(status: Ticket['status'], createdAt = '2026-11-16T08:00:00Z', extra: Partial<Ticket> = {}): Ticket {
  return { officeId: 'clinic', ticketNo: 1, queueKey: 1, secretHash: randomUUID(), misses: 0,
    status, createdAt, expiresAt: now / 1000 + 3600, ...extra };
}

describe('dayStats', () => {
  it('returns complete empty statistics', () => {
    expect(dayStats(snapshot([]), now, zone)).toEqual({ date: '2026-11-16', issued: 0, seen: 0,
      left: 0, missed: 0, waitingNow: 0, medianWaitMinutes: null, longestWaitMinutes: null,
      busiestHour: null, desks: [] });
  });
  it('counts every status and uses the lower middle wait, flooring minutes', () => {
    const tickets = [ticket('waiting'), ticket('called'), ticket('left'), ticket('no_show'),
      ticket('serving', undefined, { servedAt: '2026-11-16T08:10:59Z', desk: 'Desk B' }),
      ticket('done', undefined, { servedAt: '2026-11-16T08:20:00Z', desk: 'Desk A' })];
    const before = structuredClone(tickets);
    expect(dayStats(snapshot(tickets), now, zone)).toEqual({ date: '2026-11-16', issued: 6,
      seen: 2, left: 1, missed: 1, waitingNow: 2, medianWaitMinutes: 10, longestWaitMinutes: 20,
      busiestHour: { hour: 10, issued: 6 }, desks: [{ desk: 'Desk A', seen: 1 }, { desk: 'Desk B', seen: 1 }] });
    expect(tickets).toEqual(before);
  });
  it('filters at local midnight and excludes expired tickets', () => {
    const tickets = [ticket('waiting', '2026-11-15T21:59:00Z'), ticket('waiting', '2026-11-15T22:00:00Z'),
      ticket('waiting', undefined, { expiresAt: now / 1000 }), ticket('waiting', '2026-11-16T22:00:00Z')];
    expect(dayStats(snapshot(tickets), now, zone)).toMatchObject({ issued: 1, busiestHour: { hour: 0, issued: 1 } });
  });
  it('breaks busiest-hour ties toward the earlier hour and sorts desks by count first', () => {
    const tickets = [ticket('done', '2026-11-16T09:00:00Z', { servedAt: '2026-11-16T09:03:00Z', desk: 'B' }),
      ticket('done', '2026-11-16T08:00:00Z', { servedAt: '2026-11-16T08:04:00Z', desk: 'B' }),
      ticket('done', '2026-11-16T08:00:00Z', { servedAt: '2026-11-16T08:05:00Z', desk: 'A' }),
      ticket('waiting', '2026-11-16T09:00:00Z')];
    expect(dayStats(snapshot(tickets), now, zone)).toMatchObject({ medianWaitMinutes: 4,
      busiestHour: { hour: 10, issued: 2 }, desks: [{ desk: 'B', seen: 2 }, { desk: 'A', seen: 1 }] });
  });
});
