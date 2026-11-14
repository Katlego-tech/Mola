import type { Board } from './messages';

// Stack parameters arrive as environment variables (infra.md 3). Read on each call so a test can
// set them, and fail loudly rather than run with a number nobody chose.
function intEnv(name: string): number {
  const value = Number(process.env[name]);
  if (!Number.isSafeInteger(value)) throw new Error(`${name} is not set to a whole number`);
  return value;
}

export function rules(): Board['rules'] {
  return {
    confirmWindowSeconds: intEnv('CONFIRM_WINDOW_SECONDS'),
    dropBackPlaces: intEnv('DROP_BACK_PLACES'),
    maxMisses: intEnv('MAX_MISSES'),
  };
}

export function ticketLifetimeSeconds(): number {
  return intEnv('TICKET_LIFETIME_HOURS') * 3600;
}

/** API Gateway closes every WebSocket connection after 2 hours (realtime.md 2). */
export const CONNECTION_TTL_SECONDS = 7200;

export const OFFICE_ID = /^[a-z0-9-]{1,40}$/;
