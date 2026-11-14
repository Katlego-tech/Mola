import { describe, expect, it } from 'vitest';
import type { Ticket } from '../src/lib/model';
import { dropBackKey, positions, waitingLine } from '../src/lib/ordering';

const nowSec = 1_800_000_000;

function ticket(ticketNo: number, overrides: Partial<Ticket> = {}): Ticket {
  return {
    officeId: 'mola',
    ticketNo,
    status: 'waiting',
    queueKey: ticketNo,
    secretHash: 'a'.repeat(64),
    misses: 0,
    createdAt: '2027-01-15T08:00:00.000Z',
    expiresAt: nowSec + 3600,
    ...overrides,
  };
}

describe('waitingLine', () => {
  it('sorts by queueKey, breaking ties by ticketNo without changing the input', () => {
    const tickets = [ticket(5, { queueKey: 2.5 }), ticket(3), ticket(4, { queueKey: 2.5 })];
    const original = structuredClone(tickets);

    expect(waitingLine(tickets, nowSec).map(({ ticketNo }) => ticketNo)).toEqual([4, 5, 3]);
    expect(tickets).toEqual(original);
  });

  it('excludes every status other than waiting', () => {
    const statuses: Ticket['status'][] = ['called', 'serving', 'done', 'left', 'no_show'];
    const tickets = statuses.map(
      (status, index) => ticket(index + 1, { status }),
    );
    const waiting = ticket(6);

    expect(waitingLine([...tickets, waiting], nowSec)).toEqual([waiting]);
  });

  it('excludes tickets expired before or exactly at now', () => {
    const live = ticket(3, { expiresAt: nowSec + 1 });
    expect(waitingLine([
      ticket(1, { expiresAt: nowSec - 1 }),
      ticket(2, { expiresAt: nowSec }),
      live,
    ], nowSec)).toEqual([live]);
  });

  it('returns an empty line for no tickets', () => {
    expect(waitingLine([], nowSec)).toEqual([]);
  });
});

describe('positions', () => {
  it('maps ticket numbers to their 1-based index in the supplied line', () => {
    const line = [ticket(42, { queueKey: 1.5 }), ticket(7), ticket(50)];
    expect(positions(line)).toEqual(new Map([[42, 1], [7, 2], [50, 3]]));
  });

  it('returns an empty map for an empty line', () => {
    expect(positions([])).toEqual(new Map());
  });
});

describe('dropBackKey', () => {
  it('implements §3.1: ticket 42 drops behind three people to key 45.5, position 4', () => {
    const line = [43, 44, 45, 46, 47, 48].map((ticketNo) => ticket(ticketNo));
    const original = structuredClone(line);
    const queueKey = dropBackKey(line, 3, 48, 42);

    expect(queueKey).toBe(45.5);
    expect(positions(waitingLine([...line, ticket(42, { queueKey })], nowSec)).get(42)).toBe(4);
    expect(line).toEqual(original);
  });

  it('preserves the missed ticket key when the line is empty', () => {
    expect(dropBackKey([], 3, 48, 42.25)).toBe(42.25);
  });

  it('places the ticket at the tail when the line length equals K', () => {
    const line = [43, 44, 45].map((ticketNo) => ticket(ticketNo));
    expect(dropBackKey(line, 3, 48, 42)).toBe(48.5);
  });

  it('places the ticket behind a shorter line and ahead of a later joiner', () => {
    const line = [ticket(43), ticket(44)];
    const queueKey = dropBackKey(line, 3, 48, 42);

    expect(queueKey).toBe(48.5);
    expect(waitingLine([...line, ticket(42, { queueKey }), ticket(49)], nowSec)
      .map(({ ticketNo }) => ticketNo)).toEqual([43, 44, 42, 49]);
  });

  it('uses the last waiting key when it exceeds the ticket counter', () => {
    expect(dropBackKey([ticket(43, { queueKey: 48.5 })], 3, 48, 42)).toBe(49);
  });

  it.each([0, -1, 0.5])('throws when places is %s, including for an empty line', (places) => {
    expect(() => dropBackKey([ticket(43)], places, 48, 42)).toThrow();
    expect(() => dropBackKey([], places, 48, 42)).toThrow();
  });
});
