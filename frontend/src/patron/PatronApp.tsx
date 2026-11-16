import { useCallback, useEffect, useRef, useState } from 'react';
import { VoiceContext, useVoice } from '@/lib/voice';
import { LangProvider, useT } from '@/i18n';
import { buzz, chime, holdWakeLock, isSoundUnlocked, unlockSound } from '@/lib/alerts';
import type { Board, ClientMessage, TicketView } from '@/lib/messages';
import { forgetTicket, loadTicket, saveTicket, type StoredTicket } from '@/lib/storedTicket';
import { OFFICE_ID, useOfficeSocket } from '@/lib/useOfficeSocket';
import { AskSheet, type AskSheetHandle } from './AskSheet';
import { PatronView } from './PatronView';

const CLOSED = new Set(['done', 'left', 'no_show']);
/** No message for this long and the page comes back to the foreground: assume the socket died
 *  silently while the phone slept, and reconnect (the resume restores the ticket). */
const STALE_MS = 60_000;

function PatronSession({ officeId }: { officeId: string }) {
  const { t } = useT();
  const [code, setCode] = useState(() => {
    const value = new URLSearchParams(window.location.search).get('c');
    return value && /^[A-Za-z0-9_-]{16}$/.test(value) ? value : null;
  });
  const [staleCode, setStaleCode] = useState(false);
  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.has('c')) {
      url.searchParams.delete('c');
      window.history.replaceState(window.history.state, '', url);
    }
  }, []);
  const voice = useVoice('mola:voice');
  const interruptVoice = voice.interrupt;
  const unlockVoice = voice.unlock;
  const voiceUnlocked = voice.isUnlocked;
  const [audioUnlocked, setAudioUnlocked] = useState(false);
  const unlockAlerts = useCallback(() => {
    void Promise.all([unlockSound(), unlockVoice()]).then(() => {
      setAudioUnlocked(isSoundUnlocked() && voiceUnlocked());
    });
  }, [unlockVoice, voiceUnlocked]);
  const announced = useRef(new Set<string>());
  const announcing = useRef(new Set<string>());
  const askSheet = useRef<AskSheetHandle>(null);
  const [stored, setStored] = useState<StoredTicket | null>(() => loadTicket(officeId));
  const storedRef = useRef(stored);
  const [view, setView] = useState<{ ticket: TicketView; board: Board; receivedAt: number } | null>(null);
  const [joining, setJoining] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const confirmRef = useRef<{ message: Extract<ClientMessage, { action: 'confirm' }>; tries: number } | null>(null);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const statusRef = useRef<TicketView['status'] | null>(null);
  const [tooLate, setTooLate] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const viewRef = useRef(false);
  const snapshotAt = useRef(-Infinity);
  const sendRef = useRef<((msg: Parameters<typeof send>[0]) => void) | null>(null);
  const RESUME_RETRY_MS = 2000;
  const [lastUpdateAt, setLastUpdateAt] = useState(() => Date.now());
  const lastUpdateRef = useRef(lastUpdateAt);

  const clearConfirm = () => {
    if (confirmTimer.current !== null) clearTimeout(confirmTimer.current);
    confirmTimer.current = null;
    confirmRef.current = null;
    setConfirming(false);
  };

  const remember = (ticket: StoredTicket | null) => {
    storedRef.current = ticket;
    setStored(ticket);
    if (ticket) saveTicket(officeId, ticket);
    else forgetTicket(officeId);
  };

  const { state, send, reconnect } = useOfficeSocket(officeId, 'patron', {
    onOpen: (sendNow) => {
      clearConfirm();
      // A join tapped before a drop never got its answer; let the patron tap again.
      setJoining(false);
      setFailure(null);
      voice.interrupt();
      askSheet.current?.reconnect();
      const own = storedRef.current;
      if (own) sendNow({ action: 'resume', ticketNo: own.ticketNo, secret: own.secret });
    },
    onMessage: (msg) => {
      if (msg.type === 'status' || msg.type === 'board') {
        if (msg.board.snapshotAt < snapshotAt.current) return;
        snapshotAt.current = msg.board.snapshotAt;
      }
      const at = Date.now();
      lastUpdateRef.current = at;
      setLastUpdateAt(at);
      const spoken = voice.receive(msg);
      if (spoken || msg.type === 'speech' || (msg.type === 'error' && msg.code === 'voice_unavailable')) return;
      askSheet.current?.receive(msg);
      switch (msg.type) {
        case 'ticket':
          setCode(null);
          snapshotAt.current = -Infinity;
          setFailure(null);
          remember({ ticketNo: msg.ticketNo, secret: msg.secret });
          setJoining(false);
          setTooLate(false);
          break;
        case 'status': {
          if (statusRef.current !== msg.ticket.status) clearConfirm();
          statusRef.current = msg.ticket.status;
          if (msg.ticket.status === 'called' && msg.ticket.deadline !== null && voice.enabled) {
            const key = `${msg.ticket.ticketNo}:${msg.ticket.deadline}`;
            if (!announced.current.has(key) && !announcing.current.has(key)) {
              announcing.current.add(key);
              voice.call(msg.ticket.ticketNo, message => sendRef.current?.(message), () => {
                announcing.current.delete(key);
                announced.current.add(key);
              }, () => announcing.current.delete(key));
            }
          }
          viewRef.current = true;
          setFailure(null);
          setView({ ticket: msg.ticket, board: msg.board, receivedAt: at });
          if (msg.ticket.status !== 'waiting' && msg.ticket.status !== 'no_show') setTooLate(false);
          if (CLOSED.has(msg.ticket.status)) remember(null);
          break;
        }
        case 'notice':
          if (msg.code === 'too_late') {
            clearConfirm();
            setTooLate(true);
          }
          break;
        case 'error':
          setJoining(false);
          if (msg.code === 'stale_code') {
            setCode(null);
            setStaleCode(true);
          }
          if (msg.code === 'not_called' && confirmRef.current && statusRef.current === 'called') {
            if (confirmRef.current.tries >= 5) clearConfirm();
            else if (confirmTimer.current === null) {
              confirmTimer.current = setTimeout(() => {
                confirmTimer.current = null;
                const pending = confirmRef.current;
                if (!pending || statusRef.current !== 'called') return;
                pending.tries++;
                sendRef.current?.(pending.message);
              }, 1000);
            }
          }
          if (msg.code === 'internal') {
            setFailure(msg.message);
            // A resume that failed on the server would leave the page waiting forever: try again.
            const own = storedRef.current;
            if (own && !viewRef.current) {
              setTimeout(() => sendRef.current?.({ action: 'resume', ticketNo: own.ticketNo, secret: own.secret }), RESUME_RETRY_MS);
            }
          }
          if (msg.code === 'bad_ticket') {
            clearConfirm();
            statusRef.current = null;
            remember(null);
            viewRef.current = false;
            setView(null);
          }
          break;
        case 'board':
          setView((current) => current ? { ...current, board: msg.board, receivedAt: at } : current);
          break;
      }
    },
  });

  if (state !== 'open' && confirming) setConfirming(false);

  useEffect(() => {
    if (state !== 'open') {
      interruptVoice();
      askSheet.current?.interrupt();
      if (confirmTimer.current !== null) clearTimeout(confirmTimer.current);
      confirmTimer.current = null;
      confirmRef.current = null;
    }
  }, [state, interruptVoice]);

  useEffect(() => () => {
    if (confirmTimer.current !== null) clearTimeout(confirmTimer.current);
  }, []);

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
    window.addEventListener('pointerdown', unlockAlerts, true);
    window.addEventListener('click', unlockAlerts);
    return () => {
      window.removeEventListener('pointerdown', unlockAlerts, true);
      window.removeEventListener('click', unlockAlerts);
    };
  }, [unlockAlerts]);

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
    <VoiceContext.Provider value={voice}>
      <PatronView
        audioUnlocked={audioUnlocked}
        onUnlockAlerts={unlockAlerts}
        onAsk={() => askSheet.current?.open()}
        officeId={officeId}
        ticket={view?.ticket ?? null}
        board={view?.board ?? null}
        receivedAt={view?.receivedAt ?? 0}
        online={state === 'open'}
        resuming={stored !== null && view === null}
        joining={joining}
        canJoin={code !== null}
        staleCode={staleCode}
        confirming={confirming}
        tooLate={tooLate}
        lastUpdateAt={lastUpdateAt}
        failure={failure ? t('internalError') : null}
        onJoin={() => {
          if (!code || staleCode) return;
          setFailure(null);
          setJoining(true);
          snapshotAt.current = -Infinity;
          viewRef.current = false;
          setView(null);
          send({ action: 'join', code });
        }}
        onConfirm={() => {
          const own = storedRef.current;
          if (!own || confirmRef.current || statusRef.current !== 'called' || state !== 'open') return;
          const message = { action: 'confirm' as const, ticketNo: own.ticketNo, secret: own.secret };
          confirmRef.current = { message, tries: 1 };
          setConfirming(true);
          send(message);
        }}
        onLeave={() => {
          const own = storedRef.current;
          if (own) send({ action: 'leave', ticketNo: own.ticketNo, secret: own.secret });
        }}
      />
      {stored && <AskSheet
        key={stored.ticketNo}
        ref={askSheet}
        online={state === 'open'}
        notesVersion={view?.board.notesVersion ?? 0}
        onListen={(text, failed) => {
          const own = storedRef.current;
          if (own && state === 'open') voice.listen(own.ticketNo, own.secret, text, send, failed);
          else failed();
        }}
        onNotes={(lang) => send({ action: 'notes', lang })}
        onAsk={(question, lang) => {
          const own = storedRef.current;
          if (own) send({ action: 'ask', ticketNo: own.ticketNo, secret: own.secret, question, lang });
        }}
      />}
    </VoiceContext.Provider>
  );
}

function PatronEntry() {
  const { t } = useT();
  const officeId = new URLSearchParams(window.location.search).get('office') ?? '';
  if (!OFFICE_ID.test(officeId)) {
    return (
      <div className="mx-auto grid min-h-dvh max-w-[480px] content-center gap-3.5 px-5">
        <h1 className="text-[2.5rem] leading-[1.05] font-bold">{t('invalidOfficeTitle')}</h1>
        <p className="max-w-[32ch] text-muted">{t('invalidOfficeDescription')}</p>
      </div>
    );
  }
  return <PatronSession key={officeId} officeId={officeId} />;
}

export function PatronApp() {
  return <LangProvider><PatronEntry /></LangProvider>;
}
