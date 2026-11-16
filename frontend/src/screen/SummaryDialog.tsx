import { Dialog } from 'radix-ui';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { officeName } from '@/lib/format';
import type { ServerMessage } from '@/lib/messages';

function Tile({ label, children, detail }: { label: string; children: ReactNode; detail?: string }) {
  return (
    <div className="grid gap-[0.6vh] rounded-[14px] bg-ground px-[1vw] py-[1.6vh]">
      <span className="text-[1.9vh] font-bold text-muted">{label}</span>
      <strong className="font-mono text-[4.2vh] leading-none">{children}</strong>
      {detail && <em className="font-mono text-[2vh] font-bold text-muted not-italic">{detail}</em>}
    </div>
  );
}

export function SummaryDialog({ officeId, summary, onClose }: {
  officeId: string;
  summary: Extract<ServerMessage, { type: 'summary' }> | null;
  onClose(): void;
}) {
  const stats = summary?.stats;
  const formatted = stats ? new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(Number(stats.date.slice(0, 4)), Number(stats.date.slice(5, 7)) - 1, Number(stats.date.slice(8, 10))))) : null;
  const hour = (n: number) => `${String(n).padStart(2, '0')}:00`;
  return (
    <Dialog.Root open onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-ink/50" />
        <Dialog.Content aria-describedby={undefined} className="fixed top-1/2 left-1/2 grid max-h-[90vh] w-[56vw] min-w-[320px] -translate-x-1/2 -translate-y-1/2 gap-[2vh] overflow-auto rounded-[14px] bg-surface px-[2.4vw] py-[4vh] text-text shadow-ticket">
          <Dialog.Title className="text-[3.6vh] font-bold">Today at {officeName(officeId)}</Dialog.Title>
          {stats ? <>
            <p className="-mt-[1.4vh] text-[2.2vh] text-muted">{formatted}</p>
            <div className="grid grid-cols-4 gap-x-[0.8vw] gap-y-[1.2vh]">
              <Tile label="Tickets issued">{stats.issued}</Tile>
              <Tile label="Seen">{stats.seen}</Tile>
              <Tile label="Left">{stats.left}</Tile>
              <Tile label="Missed">{stats.missed}</Tile>
              <Tile label="Still waiting">{stats.waitingNow}</Tile>
              {stats.medianWaitMinutes !== null && <Tile label="Median wait">{stats.medianWaitMinutes}<small className="ml-[0.3vw] text-[2.2vh]"> min</small></Tile>}
              {stats.longestWaitMinutes !== null && <Tile label="Longest wait">{stats.longestWaitMinutes}<small className="ml-[0.3vw] text-[2.2vh]"> min</small></Tile>}
              {stats.busiestHour !== null && <Tile label="Busiest hour" detail={`to ${hour(stats.busiestHour.hour + 1)}`}>{hour(stats.busiestHour.hour)}</Tile>}
            </div>
            <div className="flex flex-wrap items-baseline gap-[2vw] text-[2.2vh]">
              <b className="text-[1.9vh] text-muted">Seen per desk</b>
              {stats.desks.map(({ desk, seen }) => <span key={desk}>{desk} <span className="font-mono font-bold">{seen}</span></span>)}
            </div>
            <div className="border-l-[0.5vh] border-ticket-deep py-[0.4vh] pl-[1.2vw]">
              <h2 className="mb-[0.8vh] text-[1.9vh] text-muted">Summary by Amazon Nova</h2>
              <p className="whitespace-pre-line text-[2.3vh] leading-[1.45]">{summary.text ?? (stats.issued === 0 ? 'No tickets yet today.' : "The written summary isn't available right now. The numbers above are complete.")}</p>
            </div>
          </> : <p role="status" className="text-[2.2vh] text-muted">Loading summary…</p>}
          <div className="flex justify-end"><Button variant="ticket" onClick={onClose} className="px-[2.4vw] py-[1.8vh] text-[2.6vh]">Close</Button></div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
