import type { ClientEvent } from './client';
import { MAX_ASKS_PER_TICKET, MAX_SPEAKS_PER_TICKET, officeTimeZone } from '../lib/config';
import { getConnection, getNotes, getNotesTranslation, loadOffice, putNotesTranslation, refundAsk, reserveAsk, refundSpeak, reserveSpeak } from '../lib/db';
import { groundedNumbers, sameNumbers } from '../lib/grounding';
import { parseClientMessage } from '../lib/messages';
import { ACTIVE } from '../lib/model';
import { converseText, converseTool, NovaError } from '../lib/nova';
import { askPrompt, notesPrompt, summaryPrompt } from '../lib/prompts';
import { OK, replyError } from '../lib/reply';
import { verifySecret } from '../lib/secret';
import { verifyStaffKey } from '../lib/staff-key';
import { dayStats } from '../lib/stats';
import { speechUrl } from '../lib/voice';
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
    switch (msg.action) {
      case 'speak': {
        const start = Date.now();
        let chars = 0;
        let cached = false;
        let outcome = 'bad_ticket';
        let reserved = false;
        try {
          const snapshot = await loadOffice(conn.officeId);
          const ticket = snapshot.tickets.find(ticket => ticket.ticketNo === msg.ticketNo);
          if (!ticket || (msg.what === 'call'
            ? ticket.status !== 'called' || !ticket.desk
            : !verifySecret(msg.secret, ticket.secretHash) || !ACTIVE.has(ticket.status))) {
            await replyError(connectionId, 'bad_ticket');
            return OK;
          }
          const text = msg.what === 'call' ? `Ticket ${ticket.ticketNo}, please go to ${ticket.desk}.` : msg.text;
          chars = text.length;
          if (msg.what === 'answer') {
            await reserveSpeak(conn.officeId, msg.ticketNo, MAX_SPEAKS_PER_TICKET);
            reserved = true;
          }
          const url = await speechUrl(text, hit => { cached = hit; });
          outcome = 'ok';
          await send(connectionId, { type: 'speech', what: msg.what, ticketNo: msg.ticketNo, url });
        } catch {
          outcome = 'voice_unavailable';
          if (reserved) await refundSpeak(conn.officeId, msg.ticketNo).catch(() => undefined);
          await replyError(connectionId, 'voice_unavailable');
        } finally {
          console.log(JSON.stringify({ action: 'speak', what: msg.what, chars, cached, latencyMs: Date.now() - start, outcome }));
        }
        return OK;
      }
      case 'ask': {
        const snapshot = await loadOffice(conn.officeId);
        const ticket = snapshot.tickets.find(ticket => ticket.ticketNo === msg.ticketNo);
        if (!ticket || !verifySecret(msg.secret, ticket.secretHash) || !ACTIVE.has(ticket.status)) {
          await replyError(connectionId, 'bad_ticket');
          return OK;
        }
        let asks: number;
        try {
          asks = await reserveAsk(conn.officeId, msg.ticketNo, MAX_ASKS_PER_TICKET);
        } catch (error) {
          if (!(error instanceof Error && error.name === 'ConditionalCheckFailedException')) throw error;
          await replyError(connectionId, 'ask_limit');
          return OK;
        }
        const notes = await getNotes(conn.officeId);
        let found = false;
        let answer: string | null = null;
        if (notes?.text) {
          try {
            const result = await converseTool<unknown>(askPrompt(conn.officeId, notes.text, msg.question, msg.lang));
            if (typeof result !== 'object' || result === null || !('found' in result)
              || typeof result.found !== 'boolean' || !('answer' in result)
              || typeof result.answer !== 'string' || result.answer.length > 600) {
              throw new NovaError('malformed');
            }
            found = result.found && groundedNumbers(result.answer, [notes.text]);
            answer = found ? result.answer : null;
          } catch {
            await refundAsk(conn.officeId, msg.ticketNo).catch(() => undefined);
            await replyError(connectionId, 'assist_unavailable');
            return OK;
          }
        }
        await send(connectionId, { type: 'answer', question: msg.question, found, answer, asksLeft: MAX_ASKS_PER_TICKET - asks });
        return OK;
      }
      case 'notes': {
        const notes = await getNotes(conn.officeId);
        const version = notes?.version ?? 0;
        const text = notes?.text ?? '';
        if (msg.lang !== 'en' && text) {
          const cached = await getNotesTranslation(conn.officeId, msg.lang, version);
          if (cached) {
            await send(connectionId, { type: 'notes', lang: msg.lang, version, text: cached.text, translated: true });
            return OK;
          }
          let translated: string | null = null;
          try {
            const candidate = await converseText(notesPrompt(text, msg.lang));
            if (sameNumbers(text, candidate)) translated = candidate;
          } catch {
            // English notes remain available when translation fails.
          }
          if (translated !== null) {
            try {
              await putNotesTranslation(conn.officeId, msg.lang, version, translated, Math.floor(Date.now() / 1000) + 30 * 86400);
            } catch (error) {
              if (!(error instanceof Error && error.name === 'ConditionalCheckFailedException')) throw error;
            }
            await send(connectionId, { type: 'notes', lang: msg.lang, version, text: translated, translated: true });
            return OK;
          }
        }
        await send(connectionId, { type: 'notes', lang: 'en', version, text, translated: false });
        return OK;
      }
      case 'daySummary': {
        if (conn.role !== 'screen' || !verifyStaffKey(msg.staffKey)) {
          await replyError(connectionId, 'forbidden');
          return OK;
        }
        const snapshot = await loadOffice(conn.officeId);
        const stats = dayStats(snapshot, Date.now(), officeTimeZone());
        let text: string | null = null;
        if (stats.issued > 0) {
          try {
            const candidate = await converseText(summaryPrompt(stats));
            const sources = [JSON.stringify(stats)];
            if (stats.busiestHour) {
              const hour = stats.busiestHour.hour;
              sources.push(`${hour}:00`, `${hour + 1}:00`);
            }
            if (groundedNumbers(candidate, sources)) text = candidate;
          } catch {
            // Computed statistics remain complete when the written summary fails.
          }
        }
        await send(connectionId, { type: 'summary', stats, text });
        return OK;
      }
      default:
        await replyError(connectionId, 'unknown_action');
    }
  } catch {
    await replyError(connectionId, 'internal').catch(() => undefined);
  }
  return OK;
}
