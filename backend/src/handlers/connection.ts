import { CONNECTION_TTL_SECONDS, OFFICE_ID } from '../lib/config';
import { deleteConnection, deleteScreen, getConnection, putConnection, removeTicketConnection } from '../lib/db';

export interface ConnectionEvent {
  requestContext: { routeKey: string; connectionId: string };
  queryStringParameters?: Record<string, string | undefined> | null;
}

const ROLES = new Set(['patron', 'screen']);

async function bestEffort(what: string, step: () => Promise<unknown>): Promise<void> {
  try {
    await step();
  } catch (error) {
    console.warn(`disconnect: ${what} skipped`, error);
  }
}

// $connect and $disconnect (realtime.md 4.2, 4.5).
export async function handler(event: ConnectionEvent) {
  const { routeKey, connectionId } = event.requestContext;

  if (routeKey === '$connect') {
    const officeId = event.queryStringParameters?.office ?? '';
    const role = event.queryStringParameters?.role ?? 'patron';
    if (!OFFICE_ID.test(officeId) || !ROLES.has(role)) {
      return { statusCode: 400, body: 'Invalid office or role' };
    }
    await putConnection({
      connectionId,
      officeId,
      role: role as 'patron' | 'screen',
      expiresAt: Math.floor(Date.now() / 1000) + CONNECTION_TTL_SECONDS,
    });
    return { statusCode: 200 };
  }

  // $disconnect is best effort (API Gateway does not guarantee it); TTL cleans up the rest.
  // A failed read must not skip the rest: the connection item is still deleted below.
  const conn = await getConnection(connectionId).catch((error: unknown) => {
    console.warn('disconnect: connection read skipped', error);
    return null;
  });
  await bestEffort('connection', () => deleteConnection(connectionId));
  if (conn?.role === 'screen') await bestEffort('screen', () => deleteScreen(conn.officeId, connectionId));
  if (conn?.ticketNo !== undefined) {
    const { officeId, ticketNo } = conn;
    // Fails its condition when the ticket has already moved to a newer connection: that is fine.
    await bestEffort('ticket', () => removeTicketConnection(officeId, ticketNo, connectionId));
  }
  return { statusCode: 200 };
}
