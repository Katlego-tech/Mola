// The patron's own ticket secret (domain-model 3.2), kept per office. Storage can be missing or
// throw (private mode, blocked site data), so every access is guarded and failure means "none".

export interface StoredTicket { ticketNo: number; secret: string }

const key = (officeId: string) => `mola:${officeId}`;

export function loadTicket(officeId: string): StoredTicket | null {
  try {
    const raw = localStorage.getItem(key(officeId));
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (typeof value === 'object' && value !== null && 'ticketNo' in value && 'secret' in value
      && typeof value.ticketNo === 'number' && typeof value.secret === 'string') {
      return { ticketNo: value.ticketNo, secret: value.secret };
    }
    return null;
  } catch {
    return null;
  }
}

export function saveTicket(officeId: string, ticket: StoredTicket): void {
  try {
    localStorage.setItem(key(officeId), JSON.stringify(ticket));
  } catch {
    // The ticket still works for this page view; it just won't survive a reload.
  }
}

export function forgetTicket(officeId: string): void {
  try {
    localStorage.removeItem(key(officeId));
  } catch {
    // Nothing stored, nothing to forget.
  }
}
