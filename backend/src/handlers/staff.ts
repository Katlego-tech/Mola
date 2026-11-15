import type { ClientEvent } from './client';
import { broadcast } from '../lib/broadcast';
import { callNext } from '../lib/calling';
import { rules } from '../lib/config';
import { getConnection } from '../lib/db';
import { parseClientMessage } from '../lib/messages';
import { OK, replyError } from '../lib/reply';
import { verifySecret } from '../lib/secret';
import { send } from '../lib/ws';

export async function handler(event: ClientEvent) {
  const { connectionId } = event.requestContext;
  try {
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
    if (msg.action !== 'callNext') {
      await replyError(connectionId, 'unknown_action');
      return OK;
    }
    if (conn.role !== 'screen') {
      await replyError(connectionId, 'forbidden');
      return OK;
    }
    if (!verifySecret(msg.staffKey, process.env.STAFF_KEY_SHA256 ?? '')) {
      await replyError(connectionId, 'forbidden');
      return OK;
    }
    const result = await callNext(conn.officeId, msg.desk);
    if ('busy' in result) {
      await replyError(connectionId, 'desk_busy');
    } else if ('empty' in result) {
      await send(connectionId, { type: 'notice', code: 'queue_empty' });
      await broadcast(conn.officeId, rules());
    }
  } catch (error) {
    console.error('Staff handler failed', error);
    // Telling the desk is best effort: the handler always answers OK to API Gateway.
    await replyError(connectionId, 'internal').catch((replyFailure: unknown) => {
      console.error('Staff handler could not report the failure', replyFailure);
    });
  }
  return OK;
}
