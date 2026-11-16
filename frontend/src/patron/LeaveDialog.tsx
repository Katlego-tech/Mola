import { Dialog } from 'radix-ui';
import { useT } from '@/i18n';
import { Button } from '@/components/ui/button';

/** Asks before giving up a place (web.md 6.4). `onGo` styles the trigger for the green call screen. */
export function LeaveDialog({ onLeave, triggerLabel, onGo = false }: {
  onLeave(): void;
  triggerLabel?: string;
  onGo?: boolean;
}) {
  const { t } = useT();
  return (
    <Dialog.Root>
      <Dialog.Trigger asChild>
        <Button variant="quiet" size="md" className={onGo ? 'text-go-ink' : undefined}>{triggerLabel ?? t('leaveQueue')}</Button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-ink/70" />
        <Dialog.Content className="fixed inset-x-5 top-1/2 mx-auto grid max-w-[440px] -translate-y-1/2 gap-3 rounded-[14px] bg-surface p-6 text-text shadow-ticket">
          <Dialog.Title className="text-[1.375rem] font-bold">{t('leaveTitle')}</Dialog.Title>
          <Dialog.Description className="text-muted">
            {t('leaveDescription')}
          </Dialog.Description>
          <div className="mt-2 grid gap-2">
            <Dialog.Close asChild>
              <Button onClick={onLeave}>{t('leaveQueue')}</Button>
            </Dialog.Close>
            <Dialog.Close asChild>
              <Button variant="quiet" size="md">{t('stayQueue')}</Button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
