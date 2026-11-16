import { Dialog } from 'radix-ui';
import { useImperativeHandle, useRef, useState, type Ref } from 'react';
import { Button } from '@/components/ui/button';
import type { ServerMessage } from '@/lib/messages';

export interface NotesDialogHandle {
  open(): void;
  interrupt(): void;
  setSaving(pending: boolean): void;
  receive(message: ServerMessage): void;
}

export function NotesDialog({ ref, online, onLoad, onSave, onSaved }: {
  ref: Ref<NotesDialogHandle>;
  online: boolean;
  onLoad(): void;
  onSave(text: string, baseVersion: number): void;
  onSaved(): void;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [baseVersion, setBaseVersion] = useState<number | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [pending, setPending] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const phase = useRef<'closed' | 'loading' | 'ready' | 'saving' | 'conflict'>('closed');
  const [conflict, setConflict] = useState(false);
  const [serverText, setServerText] = useState<string | null>(null);
  const close = () => { phase.current = 'closed'; setOpen(false); };

  const load = () => {
    setLoadFailed(!online);
    if (online) onLoad();
  };
  const interrupt = () => {
    if (phase.current === 'loading' || phase.current === 'conflict') setLoadFailed(true);
    // A save whose reply is lost keeps the typed text and can be sent again; if the first one did
    // land, the retry comes back as a conflict, which also keeps the text.
    if (phase.current === 'saving') {
      phase.current = 'ready';
      setPending(false);
      setSaveFailed(true);
    }
  };

  useImperativeHandle(ref, () => ({
    interrupt,
    setSaving: (saving) => {
      if (phase.current === 'closed') return;
      phase.current = saving ? 'saving' : 'ready';
      setPending(saving);
    },
    open: () => {
      phase.current = 'loading';
      setOpen(true);
      setBaseVersion(null);
      setPending(false);
      setConflict(false);
      setServerText(null);
      load();
    },
    receive: (message) => {
      if (phase.current === 'closed') return;
      if (message.type === 'notes') {
        if (phase.current === 'saving') {
          close();
          onSaved();
          return;
        }
        if (phase.current === 'conflict') setServerText(message.text);
        else if (phase.current === 'loading') setText(message.text);
        else return;
        setLoadFailed(false);
        setBaseVersion(message.version);
        phase.current = 'ready';
        setPending(false);
      }
      if (message.type === 'error') {
        if (message.code === 'notes_conflict' && phase.current === 'saving') {
          phase.current = 'conflict';
          setConflict(true);
          setBaseVersion(null);
          load();
        } else if (phase.current === 'loading' || phase.current === 'conflict') {
          interrupt();
        } else {
          phase.current = 'ready';
          setPending(false);
        }
      }
    },
  }));

  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && close()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-ink/50" />
        <Dialog.Content className="fixed top-1/2 left-1/2 grid max-h-[90vh] w-[56vw] min-w-[320px] -translate-x-1/2 -translate-y-1/2 gap-[2vh] overflow-auto rounded-[14px] bg-surface px-[2.4vw] py-[4vh] text-text shadow-ticket">
          <Dialog.Title className="text-[3.6vh] font-bold">Office notes</Dialog.Title>
          <Dialog.Description className="text-[2.2vh] text-muted">Patrons read these on their phones, and Amazon Nova answers their questions from them. Say what to bring, opening hours, and anything that sends people away.</Dialog.Description>
          <form className="grid gap-[2vh]" onSubmit={(e) => {
            e.preventDefault();
            if (baseVersion === null || phase.current !== 'ready' || !online) return;
            phase.current = 'saving';
            setSaveFailed(false);
            setPending(true);
            onSave(text, baseVersion);
          }}>
            <div className="flex items-center justify-between gap-[1vw]">
              <label htmlFor="office-notes" className="text-[2vh] font-bold">Notes</label>
              <span className="font-mono text-[2vh] text-muted">{text.length} of 4000</span>
            </div>
            <textarea id="office-notes" value={text} maxLength={4000} disabled={pending || baseVersion === null} onChange={(e) => setText(e.target.value)} className="min-h-[30vh] resize-none rounded-[14px] border-2 border-muted bg-ground px-[1vw] py-[1.6vh] text-[2.3vh] leading-[1.45]" />
            {loadFailed && <div role="alert" className="grid gap-[1vh] text-[2.2vh] text-muted">
              <p>Couldn't load the notes. Try again.</p>
              <Button type="button" onClick={load}>Try again</Button>
            </div>}
            {saveFailed && <p role="alert" className="text-[2.2vh] text-ticket">The notes weren't saved. Your text is kept. Save again once the screen reconnects.</p>}
            {conflict && <p role="alert" className="text-[2.2vh] text-ticket">Someone else changed the notes. Your text is kept. Check theirs, then save again.</p>}
            {serverText !== null && <p className="whitespace-pre-line rounded-[14px] bg-ground p-[1vw] text-[2.2vh]">{serverText}</p>}
            <div className="flex justify-end gap-[1vw]">
              <Button type="button" onClick={close} className="border-2 border-line bg-transparent px-[2vw] py-[1.8vh] text-[2.6vh] text-text">Cancel</Button>
              <Button type="submit" variant="ticket" disabled={baseVersion === null || pending || !online} className="px-[2.4vw] py-[1.8vh] text-[2.6vh]">Save notes</Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
