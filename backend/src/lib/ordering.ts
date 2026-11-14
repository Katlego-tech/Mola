import type { Ticket } from './model';

/** Waiting, unexpired tickets in queue order. */
export function waitingLine(tickets: Ticket[], nowSec: number): Ticket[] {
  return tickets
    .filter((ticket) => ticket.status === 'waiting' && ticket.expiresAt > nowSec)
    .sort((a, b) => a.queueKey - b.queueKey || a.ticketNo - b.ticketNo);
}

/** ticketNo → 1-based position, for the waiting line only. */
export function positions(line: Ticket[]): Map<number, number> {
  return new Map(line.map((ticket, index) => [ticket.ticketNo, index + 1]));
}

/** New queueKey for a missed ticket. `line` is the waiting line without that ticket; `currentKey`
 *  is the missed ticket's own queueKey, returned unchanged when `line` is empty.
 *  Throws RangeError unless places is a whole number >= 1. */
export function dropBackKey(line: Ticket[], places: number, ticketCounter: number, currentKey: number): number {
  if (!Number.isInteger(places) || places < 1) {
    throw new RangeError('places must be a whole number at least 1');
  }

  const last = line.at(-1);
  if (last === undefined) {
    return currentKey;
  }
  if (line.length <= places) {
    return Math.max(last.queueKey, ticketCounter) + 0.5;
  }

  const before = line[places - 1] as Ticket;
  const after = line[places] as Ticket;
  return (before.queueKey + after.queueKey) / 2;
}
