// The wire contract lives in the backend (realtime.md 6). Type-only, so no backend code ships.
export type {
  Board,
  ClientMessage,
  ErrorCode,
  NoticeCode,
  ServerMessage,
  TicketView,
} from '../../../backend/src/lib/messages';
