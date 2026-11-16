import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OfficeSnapshot, Ticket, TicketStatus } from '../src/lib/model';
import { positions, waitingLine } from '../src/lib/ordering';

const db = vi.hoisted(() => ({ loadOffice: vi.fn(), dropBack: vi.fn(), markNoShow: vi.fn(), markLeft: vi.fn(), revertClaim: vi.fn() }));
const ws = vi.hoisted(() => ({ send: vi.fn() }));
const calling = vi.hoisted(() => ({ callNext: vi.fn() }));
const fanout = vi.hoisted(() => ({ requestBroadcast: vi.fn() }));
vi.mock('../src/lib/db', () => db);
vi.mock('../src/lib/ws', () => ws);
vi.mock('../src/lib/calling', () => calling);
vi.mock('../src/lib/broadcast', () => fanout);
const { handler } = await import('../src/handlers/missed-turn');
const now = Date.parse('2027-03-01T08:00:00.123Z');
const nowIso = new Date(now).toISOString();
const calledAt = new Date(now - 120000).toISOString();
const event = (reason: 'timeout' | 'left' | 'error') => ({ officeId: 'demo', ticketNo: 42, desk: 'Desk 2', calledAt, reason });
let ticket: Ticket;
let snapshot: OfficeSnapshot;

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers({ now });
  vi.stubEnv('CONFIRM_WINDOW_SECONDS', '120');
  vi.stubEnv('DROP_BACK_PLACES', '3');
  vi.stubEnv('MAX_MISSES', '2');
  ticket = { officeId: 'demo', ticketNo: 42, status: 'called', queueKey: 42,
    secretHash: randomUUID(), misses: 0, connectionId: 'phone', desk: 'Desk 2',
    taskToken: randomUUID(), calledAt, createdAt: nowIso, expiresAt: now / 1000 + 43200 };
  snapshot = { readAt: 1000, office: { officeId: 'demo', ticketCounter: 48, createdAt: nowIso }, tickets: [ticket], screens: [] };
  db.loadOffice.mockImplementation(() => Promise.resolve(snapshot));
  ws.send.mockResolvedValue('sent');
  calling.callNext.mockResolvedValue({ empty: true });
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllEnvs(); });

function addWaiting(count: number) {
  for (let i = 1; i <= count; i++) {
    snapshot.tickets.push({ ...ticket, status: 'waiting', ticketNo: 42 + i, queueKey: 42 + i });
  }
}
function expectBroadcast() {
  expect(fanout.requestBroadcast).toHaveBeenCalledExactlyOnceWith('demo');
}
function expectAdvance() {
  expect(calling.callNext).toHaveBeenCalledExactlyOnceWith('demo', 'Desk 2');
  expect(calling.callNext).toHaveBeenCalledBefore(fanout.requestBroadcast);
  expectBroadcast();
}
function expectNoWrites() {
  expect(db.dropBack).not.toHaveBeenCalled();
  expect(db.markNoShow).not.toHaveBeenCalled();
  expect(db.markLeft).not.toHaveBeenCalled();
  expect(db.revertClaim).not.toHaveBeenCalled();
  expect(ws.send).not.toHaveBeenCalled();
}

describe('timeout', () => {
  it('drops back to position 4 of 7, notifies, calls next, then requests a refresh', async () => {
    addWaiting(6);
    // Expired and non-waiting tickets must not influence the gap or the notice.
    snapshot.tickets.push({ ...ticket, ticketNo: 1, status: 'waiting', queueKey: 1, expiresAt: now / 1000 });
    snapshot.tickets.push({ ...ticket, ticketNo: 2, status: 'serving', queueKey: 2 });
    snapshot.tickets.reverse();
    await handler(event('timeout'));
    expect(db.loadOffice).toHaveBeenCalledExactlyOnceWith('demo');
    expect(db.dropBack).toHaveBeenCalledExactlyOnceWith('demo', 42, 45.5, 1, calledAt);
    const dropped = { ...ticket, status: 'waiting' as const, queueKey: 45.5 };
    const line = waitingLine(snapshot.tickets.filter(t => t.ticketNo !== 42).concat(dropped), now / 1000);
    expect(line).toHaveLength(7);
    expect(positions(line).get(42)).toBe(4);
    expect(ws.send).toHaveBeenCalledExactlyOnceWith('phone', { type: 'notice', code: 'dropped_back', ticketNo: 42, placesBack: 3 });
    expect(db.dropBack).toHaveBeenCalledBefore(ws.send);
    expect(ws.send).toHaveBeenCalledBefore(calling.callNext);
    expectAdvance();
  });

  it.each([0, 1, 3])('drops behind %i remaining tickets using the office counter', async count => {
    addWaiting(count);
    await handler(event('timeout'));
    expect(db.dropBack).toHaveBeenCalledExactlyOnceWith('demo', 42, count === 0 ? 42 : 48.5, 1, calledAt);
    expect(ws.send).toHaveBeenCalledExactlyOnceWith('phone', { type: 'notice', code: 'dropped_back', ticketNo: 42, placesBack: count });
    expectAdvance();
  });

  it('uses ticketNo as the counter fallback when the office is absent', async () => {
    snapshot.office = null;
    addWaiting(1);
    await handler(event('timeout'));
    expect(db.dropBack).toHaveBeenCalledExactlyOnceWith('demo', 42, 43.5, 1, calledAt);
  });

  it('allows the miss that reaches MaxMisses', async () => {
    ticket.misses = 1;
    await handler(event('timeout'));
    expect(db.dropBack).toHaveBeenCalledExactlyOnceWith('demo', 42, 42, 2, calledAt);
    expect(db.markNoShow).not.toHaveBeenCalled();
  });

  it('closes as no_show when the ticket already has MaxMisses', async () => {
    ticket.misses = 2;
    await handler(event('timeout'));
    expect(db.markNoShow).toHaveBeenCalledExactlyOnceWith('demo', 42, 3, nowIso, calledAt);
    expect(db.dropBack).not.toHaveBeenCalled();
    expect(ws.send).toHaveBeenCalledExactlyOnceWith('phone', { type: 'notice', code: 'no_show', ticketNo: 42 });
    expect(db.markNoShow).toHaveBeenCalledBefore(ws.send);
    expect(ws.send).toHaveBeenCalledBefore(calling.callNext);
    expectAdvance();
  });

  it.each([false, true])('advances without a connected phone (no_show=%s)', async noShow => {
    delete ticket.connectionId;
    if (noShow) ticket.misses = 2;
    await handler(event('timeout'));
    expect(ws.send).not.toHaveBeenCalled();
    expectAdvance();
  });

  it.each([false, true])('ignores a gone phone (no_show=%s)', async noShow => {
    if (noShow) ticket.misses = 2;
    ws.send.mockResolvedValue('gone');
    await handler(event('timeout'));
    expectAdvance();
  });
});

describe('left and error', () => {
  it('marks a called ticket left, calls next, then requests a refresh', async () => {
    await handler(event('left'));
    expect(db.markLeft).toHaveBeenCalledExactlyOnceWith('demo', 42, 'called', nowIso);
    expect(db.markLeft).toHaveBeenCalledBefore(calling.callNext);
    expect(ws.send).not.toHaveBeenCalled();
    expectAdvance();
  });

  it('reverts an error claim and requests a refresh without calling next', async () => {
    await handler(event('error'));
    expect(db.revertClaim).toHaveBeenCalledExactlyOnceWith('demo', 42);
    expect(db.revertClaim).toHaveBeenCalledBefore(fanout.requestBroadcast);
    expect(calling.callNext).not.toHaveBeenCalled();
    expect(ws.send).not.toHaveBeenCalled();
    expectBroadcast();
  });
});

const paths = [
  { reason: 'timeout' as const, write: db.dropBack, misses: 0 },
  { reason: 'timeout' as const, write: db.markNoShow, misses: 2 },
  { reason: 'left' as const, write: db.markLeft, misses: 0 },
  { reason: 'error' as const, write: db.revertClaim, misses: 0 },
];
describe('races and failures', () => {
  it.each(['timeout', 'left', 'error'] as const)('ignores a stale %s execution after the ticket was called again', async reason => {
    ticket.calledAt = nowIso;
    await handler(event(reason));
    expectNoWrites();
    if (reason === 'error') {
      expect(calling.callNext).not.toHaveBeenCalled();
      expectBroadcast();
    } else expectAdvance();
  });

  it.each([false, true])('logs a failed notice and continues (no_show=%s)', async noShow => {
    if (noShow) ticket.misses = 2;
    const error = new Error('Notice delivery failed');
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    ws.send.mockRejectedValue(error);
    await handler(event('timeout'));
    expect(ws.send).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledExactlyOnceWith('MissedTurn notice failed', 'demo', 42, error);
    expect(ws.send).toHaveBeenCalledBefore(calling.callNext);
    expectAdvance();
  });

  it.each(paths)('ignores a conditional failure for $reason (misses=$misses)', async ({ reason, write, misses }) => {
    ticket.misses = misses;
    write.mockRejectedValue(Object.assign(new Error('Race lost'), { name: 'ConditionalCheckFailedException' }));
    await handler(event(reason));
    expectBroadcast();
    if (reason === 'error') expect(calling.callNext).not.toHaveBeenCalled();
    else expectAdvance();
  });

  it.each(paths)('throws other write failures for $reason (misses=$misses)', async ({ reason, write, misses }) => {
    ticket.misses = misses;
    const error = new Error('Write failed');
    write.mockRejectedValue(error);
    await expect(handler(event(reason))).rejects.toBe(error);
    expect(calling.callNext).not.toHaveBeenCalled();
    expect(fanout.requestBroadcast).not.toHaveBeenCalled();
    expect(ws.send).not.toHaveBeenCalled();
  });

  for (const reason of ['timeout', 'left', 'error'] as const) {
    it.each<TicketStatus | 'absent'>(['waiting', 'serving', 'done', 'left', 'no_show', 'absent'])(`${reason} does not write a %s ticket`, async status => {
      if (status === 'absent') snapshot.tickets = [];
      else ticket.status = status;
      await handler(event(reason));
      expectNoWrites();
      if (reason === 'error') {
        expect(calling.callNext).not.toHaveBeenCalled();
        expectBroadcast();
      } else expectAdvance();
    });
  }

  it.each(['load', 'callNext', 'requestBroadcast'])('throws other %s errors', async source => {
    const error = new Error('Unavailable');
    if (source === 'load') db.loadOffice.mockRejectedValue(error);
    if (source === 'callNext') calling.callNext.mockRejectedValue(error);
    if (source === 'requestBroadcast') fanout.requestBroadcast.mockRejectedValue(error);
    await expect(handler(event('timeout'))).rejects.toBe(error);
    if (source !== 'requestBroadcast') expect(fanout.requestBroadcast).not.toHaveBeenCalled();
  });
});
