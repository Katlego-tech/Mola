import { broadcast } from '../lib/broadcast';
import { callNext } from '../lib/calling';
import { rules } from '../lib/config';
import { dropBack, loadOffice, markLeft, markNoShow, revertClaim } from '../lib/db';
import type { ServerMessage } from '../lib/messages';
import { dropBackKey, waitingLine } from '../lib/ordering';
import { send } from '../lib/ws';

export interface MissedTurnEvent {
  officeId: string;
  ticketNo: number;
  desk: string;
  calledAt: string;
  reason: 'timeout' | 'left' | 'error';
}

export async function handler(e: MissedTurnEvent): Promise<void> {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const { office, tickets } = await loadOffice(e.officeId);
  const ticket = tickets.find(ticket => ticket.ticketNo === e.ticketNo);
  let notice: ServerMessage | undefined;
  if (ticket?.status === 'called' && ticket.calledAt === e.calledAt) {
    try {
      switch (e.reason) {
        case 'timeout': {
          const misses = ticket.misses + 1;
          const { maxMisses, dropBackPlaces } = rules();
          if (misses > maxMisses) {
            await markNoShow(e.officeId, e.ticketNo, misses, nowIso, e.calledAt);
            notice = { type: 'notice', code: 'no_show', ticketNo: e.ticketNo };
          } else {
            const line = waitingLine(tickets.filter(other => other.ticketNo !== e.ticketNo), now / 1000);
            const key = dropBackKey(line, dropBackPlaces, office?.ticketCounter ?? e.ticketNo, ticket.queueKey);
            await dropBack(e.officeId, e.ticketNo, key, misses, e.calledAt);
            notice = { type: 'notice', code: 'dropped_back', ticketNo: e.ticketNo,
              placesBack: Math.min(dropBackPlaces, line.length) };
          }
          break;
        }
        case 'left':
          await markLeft(e.officeId, e.ticketNo, 'called', nowIso);
          break;
        case 'error':
          await revertClaim(e.officeId, e.ticketNo);
          break;
      }
    } catch (error) {
      if (!(error instanceof Error && error.name === 'ConditionalCheckFailedException')) throw error;
    }
  }
  if (notice && ticket?.connectionId) {
    try {
      await send(ticket.connectionId, notice);
    } catch (error) {
      console.error('MissedTurn notice failed', e.officeId, e.ticketNo, error);
    }
  }
  if (e.reason !== 'error') await callNext(e.officeId, e.desk);
  await broadcast(e.officeId, rules());
}
