import { JOIN_CODE_TTL_MS } from './config';
import type { Board, ServerMessage, TicketView } from './messages';
import type { OfficeSnapshot, Ticket } from './model';
import { waitingLine } from './ordering';

export function ticketView(t: Ticket, positions: Map<number, number>): TicketView {
  return {
    ticketNo: t.ticketNo,
    status: t.status,
    position: t.status === 'waiting' ? positions.get(t.ticketNo) ?? null : null,
    desk: t.status === 'called' || t.status === 'serving' ? t.desk ?? null : null,
    deadline: t.status === 'called' && t.taskToken !== undefined ? t.deadline ?? null : null,
    misses: t.misses,
  };
}

export function boardOf(officeId: string, s: OfficeSnapshot, nowMs: number, rules: Board['rules']): Board {
  const live = s.tickets.filter(ticket => ticket.expiresAt > nowMs / 1000);
  const line = waitingLine(live, nowMs / 1000);
  return {
    officeId,
    notesVersion: s.office?.notesVersion ?? 0,
    calling: live.filter(ticket => ticket.status === 'called').map(ticket => ({
      ticketNo: ticket.ticketNo,
      desk: ticket.desk as string,
      deadline: ticket.taskToken !== undefined ? ticket.deadline ?? null : null,
    })),
    serving: live.filter(ticket => ticket.status === 'serving').map(ticket => ({
      ticketNo: ticket.ticketNo, desk: ticket.desk as string,
    })),
    waitingCount: line.length,
    upNext: line.slice(0, 5).map(ticket => ticket.ticketNo),
    serverTime: nowMs,
    snapshotAt: s.readAt,
    rules,
  };
}

export function screenBoard(officeId: string, snapshot: OfficeSnapshot, nowMs: number, rules: Board['rules'], trusted: boolean): Extract<ServerMessage, { type: 'board' }> {
  const office = snapshot.office;
  return {
    type: 'board', board: boardOf(officeId, snapshot, nowMs, rules),
    ...(trusted && office?.joinCode !== undefined && office.joinCodeIssuedAt !== undefined
      ? { join: { code: office.joinCode, expiresAt: office.joinCodeIssuedAt + JOIN_CODE_TTL_MS } } : {}),
  };
}
