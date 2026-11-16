import type { ReactNode } from 'react';
import { useT } from '@/i18n';
import { cn } from '@/lib/utils';

/** The signature: a stub torn off a ticket roll (web.md 6.2). `closed` greys it and strikes the number. */
export function TicketStub({ ticketNo, closed = false, children }: { ticketNo: number; closed?: boolean; children: ReactNode }) {
  const { t } = useT();
  return (
    <section
      aria-label={t('ticketLabel', { no: ticketNo })}
      className={cn(
        'rounded-[14px]',
        closed ? 'border-2 border-dashed border-line bg-surface text-muted' : 'bg-ticket text-ink shadow-ticket',
      )}
    >
      <div className="px-6 pt-[22px] pb-[18px]">
        <p className="text-[0.875rem] font-bold">{t('yourNumber')}</p>
        <p className={cn('m-ln num mt-2.5 -ml-1 mb-1 text-[clamp(8.5rem,44vw,11.5rem)]', closed && 'line-through decoration-[6px]')}>
          <span key={ticketNo}>{ticketNo}</span>
        </p>
      </div>
      <div className="perf" aria-hidden />
      <div className="px-6 pt-[18px] pb-[22px]">{children}</div>
    </section>
  );
}

export function StubLine({ title, detail }: { title: string; detail: string }) {
  return (
    <p className="text-[1.75rem] leading-[1.1] font-bold">
      {title}
      <small className="mt-1.5 block text-[1.0625rem] font-normal">{detail}</small>
    </p>
  );
}
