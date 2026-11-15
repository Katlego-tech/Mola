import { ArrowRight } from '@phosphor-icons/react';
import type { Board } from '@/lib/messages';
import { mmss } from '@/lib/format';
import { remainingMs, useNow } from '@/lib/useNow';

type Calling = Board['calling'][number];

function CallingRow({ call, board, receivedAt, now }: { call: Calling; board: Board; receivedAt: number; now: number }) {
  const windowMs = board.rules.confirmWindowSeconds * 1000;
  const left = call.deadline === null ? null : remainingMs(call.deadline, board.serverTime, receivedAt, now);
  return (
    <li aria-label={`Ticket ${call.ticketNo}, ${call.desk}`} className="grid grid-cols-[30vh_auto_1fr] items-center gap-[3vw] border-b-2 border-line pt-[2.2vh] pb-[2.6vh] last:border-b-0">
      <span className="m-ln num text-[22vh] text-ticket">
        <span key={call.ticketNo}>{call.ticketNo}</span>
      </span>
      <ArrowRight weight="bold" className="size-[7vh] text-muted" aria-hidden />
      <div className="grid gap-[1.4vh]">
        <span className="text-[8vh] leading-none font-bold">{call.desk}</span>
        {/* The countdown changes four times a second: keep it out of the live region. */}
        <span className="font-mono text-[2.6vh] text-muted" aria-hidden={left !== null}>
          {left === null ? 'Calling now' : `${mmss(left)} left to confirm`}
        </span>
        {left !== null && (
          <div
            className="h-[0.8vh] origin-left rounded-full bg-ticket"
            style={{ transform: `scaleX(${Math.min(1, Math.max(0, left / windowMs))})` }}
            aria-hidden
          />
        )}
      </div>
    </li>
  );
}

export function CallingList({ board, receivedAt }: { board: Board; receivedAt: number }) {
  const now = useNow();
  return (
    <section className="grid content-start gap-[2.4vh]" aria-live="polite">
      <h2 className="text-[2.4vh] font-bold text-muted">Now calling</h2>
      <ol>
        {board.calling.map((call) => (
          <CallingRow key={call.ticketNo} call={call} board={board} receivedAt={receivedAt} now={now} />
        ))}
      </ol>
    </section>
  );
}
