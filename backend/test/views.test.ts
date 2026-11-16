import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Board } from '../src/lib/messages';
import type { OfficeSnapshot, Ticket } from '../src/lib/model';
import { boardOf, ticketView } from '../src/lib/views';

const nowMs = 1_800_000_000_500;
const rules: Board['rules'] = { confirmWindowSeconds: 30, dropBackPlaces: 3, maxMisses: 2 };
function ticket(ticketNo: number, overrides: Partial<Ticket> = {}): Ticket {
  return {
    officeId: 'demo', ticketNo, status: 'waiting', queueKey: ticketNo,
    secretHash: randomUUID(), misses: 1, createdAt: new Date(nowMs).toISOString(),
    expiresAt: nowMs / 1000 + 3600, ...overrides,
  };
}
function snapshot(tickets: Ticket[]): OfficeSnapshot {
  return { readAt: 1000, office: null, tickets, screens: [] };
}

describe('ticketView', () => {
  it.each<Ticket['status']>(['waiting', 'called', 'serving', 'done', 'left', 'no_show'])(
    'projects %s with only its applicable public fields', status => {
      const t = ticket(42, {
        status, desk: 'Desk 2', taskToken: randomUUID(), deadline: nowMs + 30_000,
        connectionId: 'phone',
      });
      const original = structuredClone(t);
      expect(ticketView(t, new Map([[42, 3]]))).toEqual({
        ticketNo: 42, status, position: status === 'waiting' ? 3 : null,
        desk: status === 'called' || status === 'serving' ? 'Desk 2' : null,
        deadline: status === 'called' ? nowMs + 30_000 : null, misses: 1,
      });
      expect(t).toEqual(original);
    },
  );

  it('uses null for absent position, desk and deadline', () => {
    expect(ticketView(ticket(1), new Map())).toEqual({
      ticketNo: 1, status: 'waiting', position: null, desk: null, deadline: null, misses: 1,
    });
  });

  it('hides a called deadline until a task token is stored', () => {
    expect(ticketView(ticket(1, { status: 'called', desk: 'Desk 1', deadline: nowMs }), new Map()))
      .toEqual({ ticketNo: 1, status: 'called', position: null, desk: 'Desk 1', deadline: null, misses: 1 });
  });

  it('keeps a missing deadline null even with a task token', () => {
    expect(ticketView(ticket(1, { status: 'called', taskToken: randomUUID() }), new Map()).deadline).toBeNull();
  });
});

describe('boardOf', () => {
  it('builds an empty board with the supplied office ID when META is absent', () => {
    expect(boardOf('empty', snapshot([]), nowMs, rules)).toEqual({
      officeId: 'empty', notesVersion: 0, calling: [], serving: [], waitingCount: 0, upNext: [], snapshotAt: 1000, serverTime: nowMs, rules,
    });
  });

  it('projects every status, orders the waiting line, caps upNext at five and excludes expired tickets', () => {
    const s = snapshot([
      ticket(8), ticket(7), ticket(6), ticket(5), ticket(4, { queueKey: 2.5 }),
      ticket(3, { queueKey: 2.5 }), ticket(2),
      ticket(9, { status: 'called', desk: 'Desk 1', taskToken: randomUUID(), deadline: nowMs + 30_000 }),
      ticket(10, { status: 'called', desk: 'Desk 2', deadline: nowMs + 30_000 }),
      ticket(11, { status: 'serving', desk: 'Desk 3' }),
      ...(['done', 'left', 'no_show'] as const).map((status, i) => ticket(12 + i, { status, desk: 'Old desk' })),
      ticket(15, { expiresAt: nowMs / 1000 }),
      ticket(16, { status: 'called', desk: 'Expired', expiresAt: nowMs / 1000 - 1 }),
      ticket(17, { status: 'serving', desk: 'Expired', expiresAt: nowMs / 1000 }),
    ]);
    s.office = { officeId: 'other', ticketCounter: 17, createdAt: new Date(nowMs).toISOString() };
    const original = structuredClone(s);
    expect(boardOf('demo', s, nowMs, rules)).toEqual({
      officeId: 'demo', notesVersion: 0, calling: [
        { ticketNo: 9, desk: 'Desk 1', deadline: nowMs + 30_000 },
        { ticketNo: 10, desk: 'Desk 2', deadline: null },
      ], serving: [{ ticketNo: 11, desk: 'Desk 3' }],
      waitingCount: 7, upNext: [2, 3, 4, 5, 6], snapshotAt: 1000, serverTime: nowMs, rules,
    });
    expect(s).toEqual(original);
  });
});


it('publishes the current notes version on the board', () => {
  const s = snapshot([]);
  s.office = { officeId: 'clinic', ticketCounter: 0, createdAt: new Date(nowMs).toISOString(), notesVersion: 3 };
  expect(boardOf('clinic', s, nowMs, rules).notesVersion).toBe(3);
});
