import { X } from '@phosphor-icons/react';
import { Dialog } from 'radix-ui';
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { Button } from '@/components/ui/button';
import { useT } from '@/i18n';
import type { Lang } from '@/i18n/langs';
import type { ServerMessage } from '@/lib/messages';
import { cn } from '@/lib/utils';

type Notes = Extract<ServerMessage, { type: 'notes' }>;
type Answer = Extract<ServerMessage, { type: 'answer' }>;
type Entry = { question: string; reply?: Answer | 'ask_limit' | 'assist_unavailable' };
export interface AskSheetHandle {
  open(): void;
  receive(message: ServerMessage): void;
}

export function AskSheet({ ref, notesVersion, onNotes, onAsk }: {
  ref: Ref<AskSheetHandle>;
  notesVersion: number;
  onNotes(lang: Lang): void;
  onAsk(question: string, lang: Lang): void;
}) {
  const { t, lang } = useT();
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState<Notes | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [question, setQuestion] = useState('');
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const [limited, setLimited] = useState(false);
  const [asksLeft, setAsksLeft] = useState<number | null>(null);
  const requested = useRef<string | null>(null);
  const requestedLang = useRef<Lang | null>(null);
  const heldLang = useRef<Lang | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const body = useRef<HTMLDivElement>(null);

  useImperativeHandle(ref, () => ({
    open: () => {
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      requested.current = null;
      setOpen(true);
    },
    receive: (message) => {
      if (message.type === 'notes') {
        heldLang.current = requestedLang.current;
        setNotes(message);
      }
      if (message.type === 'answer' && inFlight.current) {
        setEntries((all) => [...all.slice(0, -1), { question: message.question, reply: message }]);
        setAsksLeft(message.asksLeft);
        inFlight.current = false;
        setPending(false);
      }
      if (message.type === 'error' && inFlight.current) {
        const code = message.code;
        if (code === 'ask_limit' || code === 'assist_unavailable') {
          setEntries((all) => all.map((entry, index) => index === all.length - 1 ? { ...entry, reply: code } : entry));
          if (code === 'ask_limit') setLimited(true);
        }
        inFlight.current = false;
        setPending(false);
      }
    },
  }));

  useEffect(() => {
    if (!open) return;
    const key = `${lang}:${notesVersion}`;
    if (requested.current === key) return;
    if (requested.current !== null && notes?.version === notesVersion && heldLang.current === lang) {
      requested.current = key;
      return;
    }
    requested.current = key;
    requestedLang.current = lang;
    onNotes(lang);
  }, [open, lang, notesVersion, notes, onNotes]);

  useEffect(() => {
    if (body.current) body.current.scrollTop = body.current.scrollHeight;
  }, [entries, notes, open]);

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-10 bg-ink/50" />
        <Dialog.Content onCloseAutoFocus={(e) => { e.preventDefault(); opener.current?.focus(); }} aria-describedby={undefined} className="fixed inset-x-0 bottom-0 z-10 mx-auto grid h-[88dvh] max-w-[480px] grid-rows-[auto_auto_minmax(0,1fr)_auto] gap-3 rounded-t-[22px] bg-ground px-5 pt-2.5 pb-[18px] text-text shadow-ticket">
          <div aria-hidden className="h-[5px] w-11 justify-self-center rounded-full bg-line" />
          <div className="flex items-center justify-between">
            <Dialog.Title className="text-[1.75rem] leading-[1.1] font-bold">{t('askOffice')}</Dialog.Title>
            <Dialog.Close className="grid size-11 place-items-center rounded-full border-[1.5px] border-line bg-surface" aria-label={t('close')}><X weight="bold" aria-hidden /></Dialog.Close>
          </div>
          <div ref={body} className="grid content-start gap-3.5 overflow-auto pb-1">
            <section className="rounded-[14px] border-[1.5px] border-line bg-surface px-4 py-3.5">
              <h3 className="mb-1.5 text-[0.875rem] font-bold text-muted">{t('officeSays')}</h3>
              <p className="whitespace-pre-line">{notes ? notes.text || t('noNotes') : t('checkingNotes')}</p>
              {notes?.translated && <p className="mt-2 text-[0.875rem] text-muted">{t('notesTranslatedBy')}</p>}
            </section>
            <div aria-live="polite" className="grid gap-2.5">
              {entries.map((entry, index) => (
                <div key={index} className="grid gap-2.5">
                  <p className="max-w-[85%] justify-self-end rounded-[16px_16px_4px_16px] bg-line px-3.5 py-2.5 font-semibold">{entry.question}</p>
                  {entry.reply && <div className={cn('max-w-[94%] rounded-[4px_16px_16px_16px] border-[1.5px] border-l-4 border-line bg-surface px-3.5 py-3', typeof entry.reply === 'object' && entry.reply.found ? 'border-l-ticket-deep' : 'text-muted')}>
                    {typeof entry.reply === 'string' ? <p>{t(entry.reply === 'ask_limit' ? 'askLimit' : 'assistUnavailable')}</p> : entry.reply.found ? <>
                      <span className="mb-1.5 block text-[0.875rem] font-bold text-muted">{t('answerLabel')}</span>
                      <p className="whitespace-pre-line">{entry.reply.answer}</p>
                      <p className="mt-2 text-[0.875rem] text-muted">{t('answerBy')}</p>
                    </> : <p>{t('answerNotFound')}</p>}
                  </div>}
                </div>
              ))}
            </div>
          </div>
          <form className="grid gap-2 border-t-[1.5px] border-line pt-3" onSubmit={(e) => {
            e.preventDefault();
            const trimmed = question.trim();
            if (inFlight.current || limited || !trimmed || trimmed.length > 300) return;
            inFlight.current = true;
            setPending(true);
            setEntries((all) => [...all, { question: trimmed }]);
            setQuestion('');
            onAsk(trimmed, lang);
          }}>
            <label htmlFor="office-question" className="text-[0.875rem] font-bold">{t('yourQuestion')}</label>
            <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
              <input id="office-question" value={question} maxLength={300} disabled={limited || pending} onChange={(e) => setQuestion(e.target.value)} className="min-h-[52px] min-w-0 rounded-[14px] border-2 border-muted bg-surface px-3.5" />
              <Button type="submit" disabled={pending || limited || !question.trim()} className="min-h-[52px] px-[18px] text-[1.0625rem]">{t(pending ? 'checkingNotes' : 'ask')}</Button>
            </div>
            <p className="text-[0.875rem] text-muted">{t('askHint')}</p>
            {asksLeft !== null && <p className="text-[0.875rem] text-muted">{t(asksLeft === 1 ? 'asksLeftOne' : 'asksLeftMany', { n: asksLeft })}</p>}
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
