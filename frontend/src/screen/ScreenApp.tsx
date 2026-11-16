import { useEffect, useRef, useState } from 'react';
import type { Board, ServerMessage } from '@/lib/messages';
import { officeName } from '@/lib/format';
import { OFFICE_ID, useOfficeSocket } from '@/lib/useOfficeSocket';
import { BoardView } from './BoardView';
import { NotesDialog, type NotesDialogHandle } from './NotesDialog';
import { SummaryDialog } from './SummaryDialog';
import { StaffStrip } from './StaffStrip';
import { UnlockDialog } from './UnlockDialog';

const DESK = /^[A-Za-z0-9 -]{1,20}$/;

function read(store: Storage, key: string): string | null {
  try {
    return store.getItem(key);
  } catch {
    return null;
  }
}
function write(store: Storage, key: string, value: string | null): void {
  try {
    if (value === null) store.removeItem(key);
    else store.setItem(key, value);
  } catch {
    // Storage unavailable: the value lasts for this page view only.
  }
}

function ScreenBoard({ officeId, staff }: { officeId: string; staff: boolean }) {
  const [view, setView] = useState<{ board: Board; receivedAt: number } | null>(null);
  const [desk, setDesk] = useState(() => read(localStorage, `mola:desk:${officeId}`) ?? 'Desk 1');
  const [pending, setPending] = useState(false);
  // The call in flight: the desk it was sent for, and the ticket that desk was already calling
  // (if any). Only a different ticket at that desk on the board answers it.
  const pendingRef = useRef<{ desk: string; before: number | null } | null>(null);
  const [log, setLog] = useState<string | null>(null);
  const [unlock, setUnlock] = useState<{ open: boolean; error: boolean }>({ open: false, error: false });
  const deskRef = useRef(desk);
  const boardRef = useRef<Board | null>(null);
  const notesDialog = useRef<NotesDialogHandle>(null);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [summary, setSummary] = useState<Extract<ServerMessage, { type: 'summary' }> | null>(null);
  const unlockAction = useRef<((key: string) => void) | null>(null);
  const keyName = `mola:staff:${officeId}`;

  const { state, send } = useOfficeSocket(officeId, 'screen', {
    onOpen: (sendNow) => {
      pendingRef.current = null;
      setPending(false);
      sendNow({ action: 'watch' });
    },
    onMessage: (msg) => {
      notesDialog.current?.receive(msg);
      switch (msg.type) {
        case 'summary':
          setSummary(msg);
          break;
        case 'board': {
          boardRef.current = msg.board;
          setView({ board: msg.board, receivedAt: Date.now() });
          const sent = pendingRef.current;
          const answer = sent && msg.board.calling.find((c) => c.desk === sent.desk && c.ticketNo !== sent.before);
          if (answer) {
            setLog(`Called ${answer.ticketNo} to ${answer.desk}.`);
            pendingRef.current = null;
            setPending(false);
          }
          break;
        }
        case 'notice':
          if (msg.code === 'queue_empty') setLog('Nobody is waiting.');
          pendingRef.current = null;
          setPending(false);
          break;
        case 'error': {
          pendingRef.current = null;
          setPending(false);
          if (msg.code === 'forbidden') {
            setSummaryOpen(false);
            write(sessionStorage, keyName, null);
            setUnlock({ open: true, error: true });
          } else if (msg.code === 'desk_busy') {
            const mine = boardRef.current?.calling.find((c) => c.desk === deskRef.current);
            setLog(mine ? `${mine.desk} is still calling ${mine.ticketNo}.` : `${deskRef.current} is still calling someone.`);
          } else {
            setLog(msg.message);
          }
          break;
        }
        default:
          break;
      }
    },
  });
  const callNext = (staffKey: string) => {
    if (!DESK.test(deskRef.current)) {
      setLog('Give this desk a name of up to 20 letters, numbers or spaces.');
      return;
    }
    const desk = deskRef.current;
    pendingRef.current = { desk, before: boardRef.current?.calling.find((c) => c.desk === desk)?.ticketNo ?? null };
    setPending(true);
    send({ action: 'callNext', desk: deskRef.current, staffKey });
  };

  const withKey = (action: (key: string) => void) => {
    unlockAction.current = action;
    const key = read(sessionStorage, keyName);
    if (key) action(key);
    else setUnlock({ open: true, error: false });
  };

  if (!view) {
    return (
      <p className="grid h-dvh place-items-center text-[3vh] text-muted">Connecting to {officeName(officeId)}</p>
    );
  }
  const joinUrl = `${import.meta.env.VITE_APP_URL}/?office=${encodeURIComponent(officeId)}`;
  return (
    <>
      <BoardView board={view.board} receivedAt={view.receivedAt} joinUrl={joinUrl} reconnecting={state !== 'open'}>
        {staff && (
          <StaffStrip
            desk={desk}
            onDesk={(next) => {
              deskRef.current = next;
              setDesk(next);
              write(localStorage, `mola:desk:${officeId}`, next);
            }}
            pending={pending}
            log={log}
            onNotes={() => notesDialog.current?.open()}
            onSummary={() => withKey((staffKey) => {
              setSummary(null);
              setSummaryOpen(true);
              send({ action: 'daySummary', staffKey });
            })}
            onCallNext={() => withKey(callNext)}
          />
        )}
      </BoardView>
      {staff && <>
        <NotesDialog
          ref={notesDialog}
          onLoad={() => send({ action: 'notes', lang: 'en' })}
          onSave={(text, baseVersion) => withKey((staffKey) => {
            notesDialog.current?.setSaving(true);
            send({ action: 'saveNotes', text, baseVersion, staffKey });
          })}
          onSaved={() => setLog('Notes saved.')}
        />
        {summaryOpen && <SummaryDialog officeId={officeId} summary={summary} onClose={() => setSummaryOpen(false)} />}
        <UnlockDialog
          open={unlock.open}
          error={unlock.error}
          onCancel={() => {
            notesDialog.current?.setSaving(false);
            setUnlock({ open: false, error: false });
          }}
          onUnlock={(key) => {
            write(sessionStorage, keyName, key);
            setUnlock({ open: false, error: false });
            unlockAction.current?.(key);
          }}
        />
      </>}
    </>
  );
}

export function ScreenApp() {
  const officeId = new URLSearchParams(window.location.search).get('office') ?? '';
  // The counter screen is a TV in a waiting room: always dark (web.md 6.1).
  useEffect(() => {
    document.documentElement.dataset.theme = 'dark';
  }, []);

  if (!OFFICE_ID.test(officeId)) {
    return (
      <div className="grid h-dvh place-content-center gap-[1.6vh] px-[6vw]">
        <h1 className="text-[6vh] leading-[1.05] font-bold">This screen needs an office.</h1>
        <p className="text-[2.8vh] text-muted">Open it as /screen?office= followed by the office code.</p>
      </div>
    );
  }
  const staff = new URLSearchParams(window.location.search).get('staff') === '1';
  return <ScreenBoard officeId={officeId} staff={staff} />;
}
