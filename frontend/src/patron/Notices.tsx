import { ArrowBendDownRight, ArrowsClockwise, Timer } from '@phosphor-icons/react';
import type { ReactNode } from 'react';
import { useT } from '@/i18n';
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
  const { t } = useT();
  return (
    <Notice icon={<ArrowBendDownRight weight="bold" />} title={t('missedTitle')}>
      {t('missedDescription', { places: rules.dropBackPlaces })}
      {misses >= rules.maxMisses && t('missedWarning')}
    </Notice>
  );
}

export function TooLateNotice() {
  const { t } = useT();
  return (
    <Notice icon={<Timer weight="bold" />} title={t('tooLateTitle')}>
      {t('tooLateDescription')}
    </Notice>
  );
}

export function ReconnectStrip({ secondsAgo }: { secondsAgo: number }) {
  const { t } = useT();
  return (
    <p role="status" className="flex items-center gap-2 rounded-[14px] border-[1.5px] border-dashed border-line bg-surface px-3.5 py-2.5 text-[0.875rem] font-semibold text-muted">
      <ArrowsClockwise weight="bold" aria-hidden />
      {t('reconnecting')}
      <span className="sr-only">{t('lastUpdated', { n: secondsAgo })}</span>
    </p>
  );
}
