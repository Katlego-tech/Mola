import { useEffect, useRef, useState } from 'react';
import { buzz, chime, holdWakeLock, unlockSound } from '@/lib/alerts';
import type { Board, TicketView } from '@/lib/messages';
import { forgetTicket, loadTicket, saveTicket, type StoredTicket } from '@/lib/storedTicket';
import { OFFICE_ID, useOfficeSocket } from '@/lib/useOfficeSocket';
import { PatronView } from './PatronView';

const CLOSED = new Set(['done', 'left', 'no_show']);
/** No message for this long and the page comes back to the foreground: assume the socket died
 *  silently while the phone slept, and reconnect (the resume restores the ticket). */
const STALE_MS = 60_000;

function PatronSession({ officeId }: { officeId: string }) {
  const [stored, setStored] = useState<StoredTicket | null>(() => loadTicket(officeId));
  const storedRef = useRef(stored);
  const [view, setView] = useState<{ ticket: TicketView; board: Board; receivedAt: number } | null>(null);
  const [joining, setJoining] = useState(false);
  const [tooLate, setTooLate] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const viewRef = useRef(false);
  const sendRef = useRef<((msg: Parameters<typeof send>[0]) => void) | null>(null);
  const RESUME_RETRY_MS = 2000;
  const [lastUpdateAt, setLastUpdateAt] = useState(() => Date.now());
  const lastUpdateRef = useRef(lastUpdateAt);

  const remember = (ticket: StoredTicket | null) => {
    storedRef.current = ticket;
    setStored(ticket);
    if (ticket) saveTicket(officeId, ticket);
    else forgetTicket(officeId);
  };

  const { state, send, reconnect } = useOfficeSocket(officeId, 'patron', {
    onOpen: (sendNow) => {
      // A join tapped before a drop never got its answer; let the patron tap again.
      setJoining(false);
      setFailure(null);
      const own = storedRef.current;
      if (own) sendNow({ action: 'resume', ticketNo: own.ticketNo, secret: own.secret });
    },
    onMessage: (msg) => {
      const at = Date.now();
      lastUpdateRef.current = at;
      setLastUpdateAt(at);
      switch (msg.type) {
        case 'ticket':
          setFailure(null);
          remember({ ticketNo: msg.ticketNo, secret: msg.secret });
          setJoining(false);
          setTooLate(false);
          break;
        case 'status':
          viewRef.current = true;
          setFailure(null);
          setView({ ticket: msg.ticket, board: msg.board, receivedAt: at });
          if (msg.ticket.status !== 'waiting' && msg.ticket.status !== 'no_show') setTooLate(false);
          if (CLOSED.has(msg.ticket.status)) remember(null);
          break;
        case 'notice':
          if (msg.code === 'too_late') setTooLate(true);
          break;
        case 'error':
          setJoining(false);
          if (msg.code === 'internal') {
            setFailure(msg.message);
            // A resume that failed on the server would leave the page waiting forever: try again.
            const own = storedRef.current;
            if (own && !viewRef.current) {
              setTimeout(() => sendRef.current?.({ action: 'resume', ticketNo: own.ticketNo, secret: own.secret }), RESUME_RETRY_MS);
            }
          }
          if (msg.code === 'bad_ticket') {
            remember(null);
            viewRef.current = false;
            setView(null);
          }
          break;
        case 'board':
          break;
      }
    },
  });

  useEffect(() => {
    sendRef.current = send;
  });

  // "It's your turn": buzz and chime once, when the status turns to called. A reload while already
  // called alerts again on purpose: the patron may have missed the first one.
  const status = view?.ticket.status;
  const previous = useRef(status);
  useEffect(() => {
    if (status === 'called' && previous.current !== 'called') {
      buzz();
      chime();
    }
    previous.current = status;
  }, [status]);

  // Keep the screen awake while a ticket is in play. Browsers drop the lock whenever the page is
  // hidden, so it is taken again each time the page comes back into view.
  const active = status === 'waiting' || status === 'called' || status === 'serving';
  useEffect(() => {
    if (!active) return;
    let release: (() => void) | null = null;
    let live = true;
    const take = () => {
      if (document.visibilityState === 'hidden') return;
      release?.();
      void holdWakeLock().then((r) => (live ? (release = r) : r?.()));
    };
    take();
    document.addEventListener('visibilitychange', take);
    return () => {
      live = false;
      document.removeEventListener('visibilitychange', take);
      release?.();
    };
  }, [active]);

  // Sound may only start after a tap; any tap on the page unlocks it.
  useEffect(() => {
    window.addEventListener('pointerdown', unlockSound, { once: true });
    return () => window.removeEventListener('pointerdown', unlockSound);
  }, []);

  // A half-open socket after the phone slept reads as "open" but delivers nothing.
  useEffect(() => {
    const check = () => {
      if (document.visibilityState === 'visible' && Date.now() - lastUpdateRef.current > STALE_MS) reconnect();
    };
    window.addEventListener('online', check);
    document.addEventListener('visibilitychange', check);
    return () => {
      window.removeEventListener('online', check);
      document.removeEventListener('visibilitychange', check);
    };
  }, [reconnect]);

  return (
    <PatronView
      officeId={officeId}
      ticket={view?.ticket ?? null}
      board={view?.board ?? null}
      receivedAt={view?.receivedAt ?? 0}
      online={state === 'open'}
      resuming={stored !== null && view === null}
      joining={joining}
      tooLate={tooLate}
      lastUpdateAt={lastUpdateAt}
      failure={failure}
      onJoin={() => {
        unlockSound();
        setFailure(null);
        setJoining(true);
        viewRef.current = false;
        setView(null);
        send({ action: 'join' });
      }}
      onConfirm={() => {
        unlockSound();
        const own = storedRef.current;
        if (own) send({ action: 'confirm', ticketNo: own.ticketNo, secret: own.secret });
      }}
      onLeave={() => {
        const own = storedRef.current;
        if (own) send({ action: 'leave', ticketNo: own.ticketNo, secret: own.secret });
      }}
    />
  );
}

export function PatronApp() {
  const officeId = new URLSearchParams(window.location.search).get('office') ?? '';
  if (!OFFICE_ID.test(officeId)) {
    return (
      <div className="mx-auto grid min-h-dvh max-w-[480px] content-center gap-3.5 px-5">
        <h1 className="text-[2.5rem] leading-[1.05] font-bold">This code isn't for an office.</h1>
        <p className="max-w-[32ch] text-muted">Ask at reception for the Mola QR code, then scan it again.</p>
      </div>
    );
  }
  return <PatronSession officeId={officeId} />;
}
