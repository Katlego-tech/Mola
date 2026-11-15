import { ArrowBendDownRight, ArrowsClockwise, Timer } from '@phosphor-icons/react';
import type { ReactNode } from 'react';
import type { Board } from '@/lib/messages';

function Notice({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div role="status" className="grid grid-cols-[auto_1fr] gap-3 rounded-[14px] border-[1.5px] border-line bg-surface px-[18px] py-4">
      <span className="text-2xl" aria-hidden>{icon}</span>
      <div>
        <strong className="block">{title}</strong>
        <p className="text-muted">{children}</p>
      </div>
    </div>
  );
}

export function MissedNotice({ misses, rules }: { misses: number; rules: Board['rules'] }) {
  return (
    <Notice icon={<ArrowBendDownRight weight="bold" />} title="You missed your turn">
      You've moved back {rules.dropBackPlaces} places and you're still in the queue.
      {misses >= rules.maxMisses && ' One more missed turn closes your ticket.'}
    </Notice>
  );
}

export function TooLateNotice() {
  return (
    <Notice icon={<Timer weight="bold" />} title="Your time to confirm ran out">
      Your place has been updated below.
    </Notice>
  );
}

export function ReconnectStrip({ secondsAgo }: { secondsAgo: number }) {
  return (
    <p role="status" className="flex items-center gap-2 rounded-[14px] border-[1.5px] border-dashed border-line bg-surface px-3.5 py-2.5 text-[0.875rem] font-semibold text-muted">
      <ArrowsClockwise weight="bold" aria-hidden />
      Reconnecting. Your place is kept.
      <span className="sr-only">Last updated {secondsAgo} seconds ago.</span>
    </p>
  );
}
