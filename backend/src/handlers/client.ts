import { rules } from '../lib/config';
import { getConnection, loadOffice, putScreen } from '../lib/db';
import { parseClientMessage } from '../lib/messages';
import { OK, replyError } from '../lib/reply';
import { boardOf } from '../lib/views';
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
