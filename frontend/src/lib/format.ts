// Formatting of values that arrive from the server. Nothing here computes queue state
// (Non-negotiable 1): each function only turns one server value into words.

/** `soweto-clinic` → `Soweto Clinic`. */
export function officeName(officeId: string): string {
  return officeId
    .split('-')
    .filter((word) => word.length > 0)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/** 1 → `1st`, 12 → `12th`, 22 → `22nd`. */
export function ordinal(n: number): string {
  const lastTwo = n % 100;
  if (lastTwo >= 11 && lastTwo <= 13) return `${n}th`;
  const suffix = ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th';
  return `${n}${suffix}`;
}

/** Milliseconds left → `m:ss`, rounding a partial second up so `0:00` only ever means "over". */
export function mmss(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** A waiting position (1-based, from the server) → the people-ahead line on the ticket. */
export function aheadLabel(position: number): string {
  if (!Number.isInteger(position) || position < 1) {
    throw new RangeError(`position must be a whole number from 1, got ${position}`);
  }
  const ahead = position - 1;
  if (ahead === 0) return "You're next";
  return ahead === 1 ? '1 person ahead' : `${ahead} people ahead`;
}
