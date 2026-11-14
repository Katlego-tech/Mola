import { useEffect, useState } from 'react';
import type { Board } from '@/lib/messages';
import { officeName } from '@/lib/format';
import { OFFICE_ID, useOfficeSocket } from '@/lib/useOfficeSocket';
import { BoardView } from './BoardView';

function ScreenBoard({ officeId }: { officeId: string }) {
  const [view, setView] = useState<{ board: Board; receivedAt: number } | null>(null);
  const { state } = useOfficeSocket(officeId, 'screen', {
    onOpen: (send) => send({ action: 'watch' }),
    onMessage: (msg) => {
      if (msg.type === 'board') setView({ board: msg.board, receivedAt: Date.now() });
    },
  });

  if (!view) {
    return (
      <p className="grid h-dvh place-items-center text-[3vh] text-muted">Connecting to {officeName(officeId)}</p>
    );
  }
  const joinUrl = `${import.meta.env.VITE_APP_URL}/?office=${encodeURIComponent(officeId)}`;
  return <BoardView board={view.board} receivedAt={view.receivedAt} joinUrl={joinUrl} reconnecting={state !== 'open'} />;
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
  return <ScreenBoard officeId={officeId} />;
}
