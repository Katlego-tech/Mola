import { isLang, type Lang } from './lang';
import type { DayStats } from './stats';
export type { Lang } from './lang';
export type { DayStats } from './stats';
import type { TicketStatus } from './model';

export type ClientMessage =
  | { action: 'ask'; ticketNo: number; secret: string; question: string; lang: Lang }
  | { action: 'notes'; lang: Lang }
  | { action: 'saveNotes'; text: string; baseVersion: number; staffKey: string }
  | { action: 'daySummary'; staffKey: string }
  | { action: 'join' }
  | { action: 'resume'; ticketNo: number; secret: string }
  | { action: 'confirm'; ticketNo: number; secret: string }
  | { action: 'leave'; ticketNo: number; secret: string }
  | { action: 'watch' }
  | { action: 'ping' }
  | { action: 'callNext'; desk: string; staffKey: string };

export type ServerMessage =
  | { type: 'answer'; question: string; found: boolean; answer: string | null; asksLeft: number }
  | { type: 'notes'; lang: Lang; version: number; text: string; translated: boolean }
  | { type: 'summary'; stats: DayStats; text: string | null }
  | { type: 'ticket'; officeId: string; ticketNo: number; secret: string }
  | { type: 'status'; ticket: TicketView; board: Board }
  | { type: 'board'; board: Board }
  | { type: 'notice'; code: NoticeCode; ticketNo?: number; placesBack?: number }
  | { type: 'error'; code: ErrorCode; message: string };

export interface TicketView {
  ticketNo: number; status: TicketStatus; position: number | null;
  desk: string | null; deadline: number | null; misses: number;
}
export interface Board {
  officeId: string; notesVersion: number;
  calling: { ticketNo: number; desk: string; deadline: number | null }[];
  serving: { ticketNo: number; desk: string }[];
  waitingCount: number; upNext: number[]; serverTime: number; snapshotAt: number;
  rules: { confirmWindowSeconds: number; dropBackPlaces: number; maxMisses: number };
}
export type NoticeCode =
  | 'dropped_back'
  | 'no_show'
  | 'too_late'
  | 'queue_empty';
export type ErrorCode =
  | 'no_session' | 'bad_request' | 'unknown_action' | 'bad_ticket'
  | 'already_has_ticket' | 'not_called' | 'forbidden' | 'desk_busy' | 'internal'
  | 'assist_unavailable' | 'ask_limit' | 'notes_conflict';

export function parseClientMessage(
  body: string | undefined,
): ClientMessage | { error: 'bad_request' | 'unknown_action' } {
  if (body === undefined || Buffer.byteLength(body, 'utf8') > 32768) {
    return { error: 'bad_request' };
  }

  let message: unknown;
  try {
    message = JSON.parse(body);
  } catch {
    return { error: 'bad_request' };
  }

  if (typeof message !== 'object' || message === null || Array.isArray(message)
    || !('action' in message) || typeof message.action !== 'string') {
    return { error: 'bad_request' };
  }

  const byteLimit = message.action === 'saveNotes' ? 32768 : message.action === 'ask' ? 4096 : 1024;
  if (Buffer.byteLength(body, 'utf8') > byteLimit) return { error: 'bad_request' };

  switch (message.action) {
    case 'ask':
      if (Object.keys(message).length === 5
        && 'ticketNo' in message && typeof message.ticketNo === 'number'
        && Number.isSafeInteger(message.ticketNo) && message.ticketNo >= 1
        && 'secret' in message && typeof message.secret === 'string'
        && message.secret.length >= 1 && message.secret.length <= 128
        && 'question' in message && typeof message.question === 'string'
        && message.question.trim().length >= 1 && message.question.trim().length <= 300
        && 'lang' in message && isLang(message.lang)) {
        return { action: 'ask', ticketNo: message.ticketNo, secret: message.secret, question: message.question.trim(), lang: message.lang };
      }
      return { error: 'bad_request' };

    case 'notes':
      if (Object.keys(message).length === 2 && 'lang' in message && isLang(message.lang)) {
        return { action: 'notes', lang: message.lang };
      }
      return { error: 'bad_request' };

    case 'saveNotes':
      if (Object.keys(message).length === 4
        && 'text' in message && typeof message.text === 'string' && message.text.length <= 4000
        && 'baseVersion' in message && typeof message.baseVersion === 'number'
        && Number.isSafeInteger(message.baseVersion) && message.baseVersion >= 0
        && 'staffKey' in message && typeof message.staffKey === 'string'
        && message.staffKey.length >= 1 && message.staffKey.length <= 128) {
        return { action: 'saveNotes', text: message.text, baseVersion: message.baseVersion, staffKey: message.staffKey };
      }
      return { error: 'bad_request' };

    case 'daySummary':
      if (Object.keys(message).length === 2
        && 'staffKey' in message && typeof message.staffKey === 'string'
        && message.staffKey.length >= 1 && message.staffKey.length <= 128) {
        return { action: 'daySummary', staffKey: message.staffKey };
      }
      return { error: 'bad_request' };

    case 'join':
    case 'watch':
    case 'ping':
      if (Object.keys(message).length === 1) {
        return { action: message.action };
      }
      return { error: 'bad_request' };

    case 'resume':
    case 'confirm':
    case 'leave':
      if (Object.keys(message).length === 3
        && 'ticketNo' in message && typeof message.ticketNo === 'number'
        && Number.isSafeInteger(message.ticketNo) && message.ticketNo >= 1
        && 'secret' in message && typeof message.secret === 'string'
        && message.secret.length >= 1 && message.secret.length <= 128) {
        return { action: message.action, ticketNo: message.ticketNo, secret: message.secret };
      }
      return { error: 'bad_request' };

    case 'callNext':
      if (Object.keys(message).length === 3
        && 'desk' in message && typeof message.desk === 'string'
        && /^[A-Za-z0-9 -]{1,20}$/.test(message.desk)
        && 'staffKey' in message && typeof message.staffKey === 'string'
        && message.staffKey.length >= 1 && message.staffKey.length <= 128) {
        return { action: message.action, desk: message.desk, staffKey: message.staffKey };
      }
      return { error: 'bad_request' };

    default:
      return { error: 'unknown_action' };
  }
}
