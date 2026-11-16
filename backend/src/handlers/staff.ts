import type { ClientEvent } from './client';
import { broadcast } from '../lib/broadcast';
import { callNext } from '../lib/calling';
import { rules } from '../lib/config';
import { getConnection, saveNotes } from '../lib/db';
import { parseClientMessage } from '../lib/messages';
import { OK, replyError } from '../lib/reply';
import { verifyStaffKey } from '../lib/staff-key';
import { send } from '../lib/ws';

export async function handler(event: ClientEvent) {
  const { connectionId } = event.requestContext;
  let savingNotes = false;
  try {
    const msg = parseClientMessage(event.body ?? undefined);
    if ('error' in msg) {
      await replyError(connectionId, msg.error);
      return OK;
    }
    savingNotes = msg.action === 'saveNotes';
    const conn = await getConnection(connectionId);
    if (!conn) {
      await replyError(connectionId, 'no_session');
      return OK;
    }
    if (msg.action !== 'callNext' && msg.action !== 'saveNotes') {
      await replyError(connectionId, 'unknown_action');
      return OK;
    }
    if (conn.role !== 'screen') {
      await replyError(connectionId, 'forbidden');
      return OK;
    }
    if (!verifyStaffKey(msg.staffKey)) {
      await replyError(connectionId, 'forbidden');
      return OK;
    }
    if (msg.action === 'saveNotes') {
      let version: number;
      try {
        version = await saveNotes(conn.officeId, msg.text, msg.baseVersion, new Date().toISOString());
      } catch (error) {
        if (!(error instanceof Error && error.name === 'TransactionCanceledException')) throw error;
        await replyError(connectionId, 'notes_conflict');
        return OK;
      }
      await send(connectionId, { type: 'notes', lang: 'en', version, text: msg.text, translated: false });
      await broadcast(conn.officeId, rules());
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
    if (!savingNotes) console.error('Staff handler failed', error);
    // Telling the desk is best effort: the handler always answers OK to API Gateway.
    await replyError(connectionId, 'internal').catch((replyFailure: unknown) => {
      if (!savingNotes) console.error('Staff handler could not report the failure', replyFailure);
    });
  }
  return OK;
}
