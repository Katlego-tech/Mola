import type { ReactNode } from 'react';
import type { Board } from '@/lib/messages';
import { officeName } from '@/lib/format';
import { CallingList } from './CallingList';
import { ServingRow } from './ServingRow';
import { SidePanel } from './SidePanel';

export function BoardView({ board, receivedAt, joinUrl, onUnlock, reconnecting, children }: {
  board: Board;
  receivedAt: number;
  joinUrl: string | null;
  onUnlock?(): void;
  reconnecting: boolean;
  children?: ReactNode;
}) {
  const empty = board.calling.length === 0 && board.serving.length === 0;
  return (
    <div className="grid h-dvh grid-cols-[1fr_31vw] overflow-hidden text-[1.6vh]">
      <main className="grid min-w-0 grid-rows-[auto_1fr_auto_auto] gap-[3vh] px-[4.5vw] py-[5vh]">
        <header className="flex items-baseline justify-between">
          <span className="font-number text-[2.6vh] font-extrabold tracking-[0.02em] [font-stretch:125%]">MOLA</span>
          <span className="text-[2.6vh] font-semibold text-muted">
            {reconnecting ? 'Reconnecting' : officeName(board.officeId)}
          </span>
        </header>
        {empty ? (
          <div className="grid max-w-[60ch] content-center gap-[1.6vh]">
            <strong className="text-[6vh] leading-[1.05]">Nobody is waiting.</strong>
            <p className="text-[2.8vh] text-muted">Scan the code to get a number. New tickets show here straight away.</p>
          </div>
        ) : (
          <CallingList board={board} receivedAt={receivedAt} />
        )}
        <ServingRow serving={board.serving} />
        {children}
      </main>
      <SidePanel board={board} joinUrl={joinUrl} onUnlock={onUnlock} />
    </div>
  );
}
