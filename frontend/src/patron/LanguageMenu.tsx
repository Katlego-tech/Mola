import { Check, SpeakerHigh, SpeakerSlash, Translate } from '@phosphor-icons/react';
import { useContext } from 'react';
import { VoiceContext } from '@/lib/voice';
import { DropdownMenu } from 'radix-ui';
import { useT } from '@/i18n';
import { LANGS, type Lang } from '@/i18n/langs';

export function LanguageMenu() {
  const voice = useContext(VoiceContext);
  const { t, lang, setLang, available } = useT();

  return (
    <>
      {voice && <div className="grid gap-1">
        <button type="button" aria-pressed={voice.enabled} onClick={voice.toggle} className="inline-flex min-h-9 items-center gap-1.5 rounded-full border-[1.5px] border-line bg-surface px-3 text-[0.875rem] font-bold whitespace-nowrap text-text">
          {voice.enabled ? <SpeakerHigh weight="bold" aria-hidden /> : <SpeakerSlash weight="bold" aria-hidden />}{t('voice')}
        </button>
        {voice.hint && <span role="status" className="text-[0.875rem] text-muted">{t('voiceHint')}</span>}
      </div>}
      {available.length > 1 && <DropdownMenu.Root>
      <DropdownMenu.Trigger className="inline-flex min-h-9 items-center gap-1.5 rounded-full border-[1.5px] border-line bg-surface px-3 text-[0.875rem] font-bold whitespace-nowrap text-text">
        <Translate weight="bold" aria-hidden />{LANGS[lang]}
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={6} aria-label={t('language')} className="z-20 grid w-[220px] rounded-[14px] border-[1.5px] border-line bg-surface p-1.5 text-text shadow-ticket">
          <DropdownMenu.RadioGroup value={lang} onValueChange={(value) => setLang(value as Lang)}>
            {available.map((language) => (
              <DropdownMenu.RadioItem key={language} value={language} className="flex min-h-12 items-center justify-between rounded-[10px] px-3 text-left font-semibold outline-none data-[highlighted]:bg-ground data-[state=checked]:bg-ground data-[state=checked]:font-extrabold">
                {LANGS[language]}
                <DropdownMenu.ItemIndicator><Check weight="bold" aria-hidden /></DropdownMenu.ItemIndicator>
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
          <p className="mt-1 border-t-[1.5px] border-line px-3 pt-2 pb-1.5 text-[0.875rem] text-muted">{t('translationsBy')}</p>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>}
    </>
  );
}
