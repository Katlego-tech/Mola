import { useEffect, useRef, useState } from 'react';
import type { ClientMessage, ServerMessage } from './messages';
import { createSocket, type SocketState } from './socket';

export const OFFICE_ID = /^[a-z0-9-]{1,40}$/;

type Send = (msg: ClientMessage) => void;

/** When a Lambda fails or is throttled, API Gateway answers with its own frame
 *  (`{message: "Internal server error", ...}`) instead of one of ours. It is the server saying the
 *  request failed, so the screens treat it as our `internal` error rather than ignoring it. */
function fromGateway(msg: ServerMessage): ServerMessage {
  if (typeof msg === 'object' && msg !== null && 'type' in msg && typeof msg.type === 'string') return msg;
  return { type: 'error', code: 'internal', message: 'Something went wrong on our side. Try again.' };
}

/** One WebSocket per mounted screen, reconnecting by itself (realtime.md 4.3, 4.5). The handlers
 *  are read through a ref, so callers can pass fresh closures without reconnecting. */
export function useOfficeSocket(
  officeId: string,
  role: 'patron' | 'screen',
  handlers: { onMessage(msg: ServerMessage): void; onOpen(send: Send): void },
): { state: SocketState; send: Send; reconnect(): void } {
  const [state, setState] = useState<SocketState>('connecting');
  // Bumping this tears the socket down and opens a fresh one (a half-open connection after sleep).
  const [generation, setGeneration] = useState(0);
  const handlersRef = useRef(handlers);
  const sendRef = useRef<Send>(() => undefined);

  useEffect(() => {
    handlersRef.current = handlers;
  });

  useEffect(() => {
    const url = `${import.meta.env.VITE_WS_URL}?office=${encodeURIComponent(officeId)}&role=${role}`;
    const socket = createSocket<ServerMessage, ClientMessage>(url, {
      onMessage: (msg) => handlersRef.current.onMessage(fromGateway(msg)),
      onState: setState,
      onOpen: () => handlersRef.current.onOpen(socket.send),
    });
    sendRef.current = socket.send;
    return () => socket.close();
  }, [officeId, role, generation]);

  return { state, send: (msg) => sendRef.current(msg), reconnect: () => setGeneration((g) => g + 1) };
}
