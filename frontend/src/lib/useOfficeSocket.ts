import { useEffect, useRef, useState } from 'react';
import type { ClientMessage, ServerMessage } from './messages';
import { createSocket, type SocketState } from './socket';

export const OFFICE_ID = /^[a-z0-9-]{1,40}$/;

type Send = (msg: ClientMessage) => void;

/** One WebSocket per mounted screen, reconnecting by itself (realtime.md 4.3, 4.5). The handlers
 *  are read through a ref, so callers can pass fresh closures without reconnecting. */
export function useOfficeSocket(
  officeId: string,
  role: 'patron' | 'screen',
  handlers: { onMessage(msg: ServerMessage): void; onOpen(send: Send): void },
): { state: SocketState; send: Send } {
  const [state, setState] = useState<SocketState>('connecting');
  const handlersRef = useRef(handlers);
  const sendRef = useRef<Send>(() => undefined);

  useEffect(() => {
    handlersRef.current = handlers;
  });

  useEffect(() => {
    const url = `${import.meta.env.VITE_WS_URL}?office=${encodeURIComponent(officeId)}&role=${role}`;
    const socket = createSocket<ServerMessage, ClientMessage>(url, {
      onMessage: (msg) => handlersRef.current.onMessage(msg),
      onState: setState,
      onOpen: () => handlersRef.current.onOpen(socket.send),
    });
    sendRef.current = socket.send;
    return () => socket.close();
  }, [officeId, role]);

  return { state, send: (msg) => sendRef.current(msg) };
}
