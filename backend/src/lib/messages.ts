import type { TicketStatus } from './model';

export type ClientMessage =
  | { action: 'join' }
  | { action: 'resume'; ticketNo: number; secret: string }
  | { action: 'confirm'; ticketNo: number; secret: string }
  | { action: 'leave'; ticketNo: number; secret: string }
  | { action: 'watch' }
  | { action: 'ping' }
  | { action: 'callNext'; desk: string; staffKey: string };

export type ServerMessage =
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
  officeId: string;
  calling: { ticketNo: number; desk: string; deadline: number | null }[];
  serving: { ticketNo: number; desk: string }[];
  waitingCount: number; upNext: number[]; serverTime: number;
  rules: { confirmWindowSeconds: number; dropBackPlaces: number; maxMisses: number };
}
export type NoticeCode =
  | 'dropped_back'
  | 'no_show'
  | 'too_late'
  | 'queue_empty';
export type ErrorCode =
  | 'no_session' | 'bad_request' | 'unknown_action' | 'bad_ticket'
  | 'already_has_ticket' | 'not_called' | 'forbidden' | 'desk_busy' | 'internal';

export function parseClientMessage(
  body: string | undefined,
): ClientMessage | { error: 'bad_request' | 'unknown_action' } {
  if (body === undefined || Buffer.byteLength(body, 'utf8') > 1024) {
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

  switch (message.action) {
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
        && Number.isInteger(message.ticketNo)
        && 'secret' in message && typeof message.secret === 'string') {
        return { action: message.action, ticketNo: message.ticketNo, secret: message.secret };
      }
      return { error: 'bad_request' };

    case 'callNext':
      if (Object.keys(message).length === 3
        && 'desk' in message && typeof message.desk === 'string'
        && /^[A-Za-z0-9 -]{1,20}$/.test(message.desk)
        && 'staffKey' in message && typeof message.staffKey === 'string') {
        return { action: message.action, desk: message.desk, staffKey: message.staffKey };
      }
      return { error: 'bad_request' };

    default:
      return { error: 'unknown_action' };
  }
}
