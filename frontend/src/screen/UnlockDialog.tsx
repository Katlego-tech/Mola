import { Dialog } from 'radix-ui';
import { useState } from 'react';
import { Button } from '@/components/ui/button';

/** Asks for the office's staff key (screen-unlock.png). The key lives only in this tab's session. */
export function UnlockDialog({ open, error, onUnlock, onCancel }: {
  open: boolean;
  error: boolean;
  onUnlock(key: string): void;
  onCancel(): void;
}) {
  const [key, setKey] = useState('');
  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onCancel()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-[rgb(21_17_31/0.78)]" />
        <Dialog.Content className="fixed top-1/2 left-1/2 grid w-[34vw] min-w-[320px] -translate-x-1/2 -translate-y-1/2 gap-[2vh] rounded-[14px] bg-surface px-[2.4vw] py-[4vh] text-text shadow-ticket">
          <Dialog.Title className="text-[3.6vh] font-bold">Unlock staff controls</Dialog.Title>
          <Dialog.Description className="text-[2.2vh] text-muted">
            Enter the staff key for this office to call patrons from this screen.
          </Dialog.Description>
          <form
            className="grid gap-[2vh]"
            onSubmit={(e) => {
              e.preventDefault();
              if (key) onUnlock(key);
              setKey('');
            }}
          >
            <label htmlFor="staff-key" className="text-[2vh] font-bold">Staff key</label>
            <input
              id="staff-key"
              type="password"
              autoComplete="off"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              className="rounded-[14px] border-2 border-muted bg-ground px-[1vw] py-[1.6vh] text-[2.6vh] text-text focus-visible:outline-ticket"
            />
            {error && <p role="alert" className="text-[2vh] font-bold text-ticket">That key didn't work. Check it and try again.</p>}
            <Button type="submit" variant="ticket" className="text-[2.6vh]">Unlock</Button>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
