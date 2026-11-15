import { broadcast } from '../lib/broadcast';
import { rules, ticketLifetimeSeconds } from '../lib/config';
import { bindTicketConnection, getConnection, loadOffice, nextTicketNo, putScreen, putTicket, setConnectionTicket } from '../lib/db';
import { parseClientMessage } from '../lib/messages';
import { ACTIVE } from '../lib/model';
import { positions, waitingLine } from '../lib/ordering';
import { OK, replyError } from '../lib/reply';
import { issueSecret, verifySecret } from '../lib/secret';
import { boardOf, ticketView } from '../lib/views';
import { send } from '../lib/ws';

export interface ClientEvent {
  requestContext: { routeKey: string; connectionId: string };
  body?: string | null;
}

// Every route a phone or screen sends on, apart from callNext (realtime.md 4.1).
export async function handler(event: ClientEvent) {
  const { routeKey, connectionId } = event.requestContext;
  if (routeKey === 'ping') return OK; // keep-alive: no read, no reply

  const msg = parseClientMessage(event.body ?? undefined);
  if ('error' in msg) {
    await replyError(connectionId, msg.error);
    return OK;
  }
  const conn = await getConnection(connectionId);
  if (!conn) {
    await replyError(connectionId, 'no_session');
    return OK;
  }

  switch (msg.action) {
    case 'join': {
      if (conn.role !== 'patron') {
        await replyError(connectionId, 'forbidden');
        return OK;
      }
      if (conn.ticketNo !== undefined) {
        const snapshot = await loadOffice(conn.officeId);
        if (snapshot.tickets.some(ticket => ticket.ticketNo === conn.ticketNo && ACTIVE.has(ticket.status))) {
          await replyError(connectionId, 'already_has_ticket');
          return OK;
        }
      }
      const now = Date.now();
      const nowIso = new Date(now).toISOString();
      const ticketNo = await nextTicketNo(conn.officeId, nowIso);
      const { secret, secretHash } = issueSecret();
      await putTicket({
        officeId: conn.officeId, ticketNo, status: 'waiting', queueKey: ticketNo,
        secretHash, connectionId, misses: 0, createdAt: nowIso,
        expiresAt: Math.floor(now / 1000) + ticketLifetimeSeconds(),
      });
      await setConnectionTicket(connectionId, ticketNo);
      await send(connectionId, { type: 'ticket', officeId: conn.officeId, ticketNo, secret });
      await broadcast(conn.officeId, rules());
      return OK;
    }
    case 'resume': {
      const snapshot = await loadOffice(conn.officeId);
      const ticket = snapshot.tickets.find(ticket => ticket.ticketNo === msg.ticketNo);
      if (!ticket || !verifySecret(msg.secret, ticket.secretHash)) {
        await replyError(connectionId, 'bad_ticket');
        return OK;
      }
      await bindTicketConnection(conn.officeId, msg.ticketNo, connectionId);
      await setConnectionTicket(connectionId, msg.ticketNo);
      const now = Date.now();
      await send(connectionId, {
        type: 'status', ticket: ticketView(ticket, positions(waitingLine(snapshot.tickets, now / 1000))),
        board: boardOf(conn.officeId, snapshot, now, rules()),
      });
      return OK;
    }
    case 'watch': {
      if (conn.role !== 'screen') {
        await replyError(connectionId, 'forbidden');
        return OK;
      }
      await putScreen({ officeId: conn.officeId, connectionId, expiresAt: conn.expiresAt });
      const snapshot = await loadOffice(conn.officeId);
      await send(connectionId, { type: 'board', board: boardOf(conn.officeId, snapshot, Date.now(), rules()) });
      return OK;
    }
    case 'ping':
      return OK;
    default:
      // join, resume, confirm, leave and callNext get their own routes in later tasks. Until a
      // route exists API Gateway delivers them here, and the API really has no such action yet.
      await replyError(connectionId, 'unknown_action');
      return OK;
  }
}
