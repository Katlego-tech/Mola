import { Check, DeviceMobileSpeaker, Ticket } from '@phosphor-icons/react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { mmss, officeName } from '@/lib/format';
import type { Board, TicketView } from '@/lib/messages';
import { remainingMs, useNow } from '@/lib/useNow';
import { cn } from '@/lib/utils';
import { AheadRow } from './AheadRow';
import { LeaveDialog } from './LeaveDialog';
import { MissedNotice, ReconnectStrip, TooLateNotice } from './Notices';
import { NowCalling } from './NowCalling';
import { StubLine, TicketStub } from './TicketStub';

export interface PatronViewProps {
  officeId: string;
  /** The last `status` from the server, or null before there is a ticket. */
  ticket: TicketView | null;
  board: Board | null;
  receivedAt: number;
  online: boolean;
  /** A stored ticket is being resumed and the server has not answered yet. */
  resuming: boolean;
  /** "Get a number" was tapped and the ticket has not arrived yet. */
  joining: boolean;
  /** The server said the confirm came after the window closed. */
  tooLate: boolean;
  lastUpdateAt: number;
  /** The last request failed on the server side; shown next to the button that can retry it. */
  failure?: string | null;
  onJoin(): void;
  onConfirm(): void;
  onLeave(): void;
}

function Page({ officeId, tone = 'ground', children, footer }: {
  officeId: string;
  tone?: 'ground' | 'go';
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className={cn('min-h-dvh', tone === 'go' && 'm-panel bg-go text-go-ink')}>
      <div className="mx-auto grid min-h-dvh max-w-[480px] grid-rows-[auto_1fr_auto] gap-5 px-5 pt-5 pb-7">
        <header className="flex items-baseline justify-between gap-3">
          <span className="font-number text-[1.05rem] font-extrabold tracking-[0.02em] [font-stretch:125%]">MOLA</span>
          <span className={cn('text-right text-[0.875rem] font-semibold', tone === 'go' ? 'text-go-ink/80' : 'text-muted')}>
            {officeName(officeId)}
          </span>
        </header>
        <main className="grid content-start gap-[18px]">{children}</main>
        <footer className="grid gap-2.5">{footer}</footer>
      </div>
    </div>
  );
}

function JoinButton({ onJoin, disabled, label, failure }: { onJoin(): void; disabled: boolean; label: string; failure?: string | null }) {
  return (
    <>
      {failure && <p role="alert" className="px-1 font-semibold text-text">{failure}</p>}
      <Button onClick={onJoin} disabled={disabled}>
        <Ticket weight="bold" aria-hidden />
        {label}
      </Button>
    </>
  );
}

function CalledView(props: PatronViewProps & { ticket: TicketView; board: Board }) {
  const now = useNow();
  const { ticket, board } = props;
  const left = ticket.deadline === null ? null : remainingMs(ticket.deadline, board.serverTime, props.receivedAt, now);
  const windowMs = board.rules.confirmWindowSeconds * 1000;
  return (
    <Page
      officeId={props.officeId}
      tone="go"
      footer={
        <>
          {props.failure && <p role="alert" className="px-1 font-semibold text-go-ink">{props.failure}</p>}
          <Button variant="onGo" onClick={props.onConfirm} disabled={left === null || left <= 0}>
            <Check weight="bold" aria-hidden />
            Confirm
          </Button>
          <LeaveDialog onLeave={props.onLeave} triggerLabel="I can't come. Leave the queue" onGo />
        </>
      }
    >
      <div role="alert">
        <h1 className="text-[2.5rem] leading-[1.05] font-bold">It's your turn.<br />Go to</h1>
        <p className="m-ln num mt-1.5 text-[clamp(6.5rem,34vw,9rem)]">
          <span>{ticket.desk}</span>
        </p>
        <span className="mt-2 inline-flex items-baseline gap-2 rounded-full bg-go-ink/15 px-3.5 py-1.5 font-bold">
          Ticket <span className="font-mono">{ticket.ticketNo}</span>
        </span>
      </div>
      {left !== null && (
        <div className="mt-6">
          <span className="font-mono text-[3.25rem] leading-none font-bold" aria-hidden>{mmss(left)}</span>
          <div
            className="mt-4 h-1.5 origin-left rounded-full bg-go-ink"
            style={{ transform: `scaleX(${Math.min(1, Math.max(0, left / windowMs))})` }}
            aria-hidden
          />
          <p className="mt-1.5 max-w-[32ch]">
            Tap Confirm before the time runs out, or you'll move back {board.rules.dropBackPlaces} places.
          </p>
        </div>
      )}
    </Page>
  );
}

export function PatronView(props: PatronViewProps) {
  const { ticket, board, officeId } = props;
  const now = useNow(1000);

  if (!ticket || !board) {
    if (props.resuming) {
      return (
        <Page officeId={officeId}>
          <p className="text-muted" role="status">Finding your ticket</p>
          {props.failure && <p role="alert" className="px-1 font-semibold">{props.failure}</p>}
        </Page>
      );
    }
    return (
      <Page officeId={officeId} footer={<JoinButton onJoin={props.onJoin} disabled={props.joining || !props.online} label="Get a number" failure={props.failure} />}>
        <div className="grid content-start gap-3.5 rounded-[14px] border-2 border-dashed border-line px-6 py-7">
          <h1 className="text-[2.5rem] leading-[1.05] font-bold">Take a number and leave the line.</h1>
          <p className="max-w-[32ch] text-muted">
            Your place shows here and updates by itself. Your phone buzzes when it's your turn.
          </p>
        </div>
      </Page>
    );
  }

  if (ticket.status === 'called') return <CalledView {...props} ticket={ticket} board={board} />;

  const reconnect = !props.online && (
    <ReconnectStrip secondsAgo={Math.max(0, Math.round((now - props.lastUpdateAt) / 1000))} />
  );

  if (ticket.status === 'serving') {
    return (
      <Page officeId={officeId}>
        {reconnect}
        <TicketStub ticketNo={ticket.ticketNo}>
          <StubLine title={`Confirmed. ${ticket.desk ?? ''} is expecting you.`} detail="Show this number at the desk." />
        </TicketStub>
      </Page>
    );
  }

  if (ticket.status === 'done' || ticket.status === 'left' || ticket.status === 'no_show') {
    const copy: Record<'done' | 'left' | 'no_show', [string, string]> = {
      done: ["You've been seen", 'This ticket is finished. Thanks for waiting.'],
      left: ["You've left the queue", 'Your place has gone to the next person.'],
      no_show: ['This ticket has closed', 'You missed your turn too many times.'],
    };
    const [title, detail] = copy[ticket.status];
    return (
      <Page officeId={officeId} footer={<JoinButton onJoin={props.onJoin} disabled={props.joining || !props.online} label="Get a new number" failure={props.failure} />}>
        <TicketStub ticketNo={ticket.ticketNo} closed>
          <StubLine title={title} detail={detail} />
        </TicketStub>
        {ticket.status === 'no_show' && (
          <p className="max-w-[34ch] px-1 text-muted">Still here? Get a new number and you'll join the end of the queue.</p>
        )}
      </Page>
    );
  }

  // waiting
  return (
    <Page officeId={officeId} footer={<LeaveDialog onLeave={props.onLeave} />}>
      {reconnect}
      {props.tooLate && <TooLateNotice />}
      {ticket.misses > 0 && <MissedNotice misses={ticket.misses} rules={board.rules} />}
      <div className={cn(!props.online && 'opacity-55')}>
        <TicketStub ticketNo={ticket.ticketNo}>
          {ticket.position !== null && <AheadRow position={ticket.position} />}
        </TicketStub>
      </div>
      <NowCalling calling={board.calling} />
      <p className="max-w-[34ch] px-1 text-muted">
        <DeviceMobileSpeaker className="mr-1 inline align-[-2px]" aria-hidden />
        Keep this page open. Your phone buzzes when it's your turn.
      </p>
    </Page>
  );
}
