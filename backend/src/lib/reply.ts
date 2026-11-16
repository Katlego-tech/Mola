import type { ErrorCode } from './messages';
import { send } from './ws';

const MESSAGES: Record<ErrorCode, string> = {
  stale_code: 'That code has expired or was already used. Scan the code on the screen again.',
  voice_unavailable: "Couldn't play the answer.",
  assist_unavailable: "The assistant isn't available right now. Ask at the desk.",
  ask_limit: "You've used all your questions for this ticket. Ask at the desk.",
  notes_conflict: 'Someone else changed the notes. Your text is kept. Check theirs, then save again.',
  no_session: 'This connection has no session. Reconnect.',
  bad_request: 'That message is not valid.',
  unknown_action: 'That action does not exist.',
  bad_ticket: 'That ticket is not yours or no longer exists.',
  already_has_ticket: 'This connection already holds a ticket.',
  not_called: 'That ticket is not being called.',
  forbidden: 'Not allowed from this connection.',
  desk_busy: 'This desk is still calling someone.',
  internal: 'Something went wrong on our side. Try again.',
};

/** Tells one connection what went wrong. A connection that has gone away needs no answer. */
export async function replyError(connectionId: string, code: ErrorCode): Promise<void> {
  await send(connectionId, { type: 'error', code, message: MESSAGES[code] });
}

export const OK = { statusCode: 200 } as const;
