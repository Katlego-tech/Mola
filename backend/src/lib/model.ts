export type TicketStatus = 'waiting' | 'called' | 'serving' | 'done' | 'left' | 'no_show';
export const ACTIVE: ReadonlySet<TicketStatus> = new Set(['waiting', 'called', 'serving']);

export interface Office { officeId: string; ticketCounter: number; createdAt: string; notesVersion?: number; }

export interface Ticket {
  officeId: string; ticketNo: number; status: TicketStatus; queueKey: number;
  secretHash: string; connectionId?: string; misses: number; desk?: string;
  taskToken?: string; deadline?: number; createdAt: string; calledAt?: string;
  servedAt?: string; closedAt?: string; asks?: number; expiresAt: number;
}

export interface Connection {
  connectionId: string; officeId: string; role: 'patron' | 'screen';
  ticketNo?: number; expiresAt: number;
}

export interface Screen { officeId: string; connectionId: string; expiresAt: number; }

export interface OfficeSnapshot { office: Office | null; tickets: Ticket[]; screens: Screen[]; }
