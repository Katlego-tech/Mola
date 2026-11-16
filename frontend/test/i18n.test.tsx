import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import en from '../src/i18n/en.json';
import type { Board, TicketView } from '../src/lib/messages';
import { LangProvider, useT } from '../src/i18n';
import { LanguageMenu } from '../src/patron/LanguageMenu';
import { PatronView } from '../src/patron/PatronView';

const catalogs = { en, zu: { aheadMany: '{n} phambili', inLineNumber: 'Inombolo {n}.' } };
function Probe() {
  const { t, lang, setLang } = useT();
  return (
    <>
      <p>{lang}</p>
      <p>{t('aheadMany', { n: 2 })}</p>
      <p>{t('confirm')}</p>
      <button onClick={() => setLang('zu')}>Switch</button>
    </>
  );
}
beforeEach(() => {
  localStorage.clear();
  vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['en']);
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('language provider', () => {
  it('persists a choice, updates the document and falls back for missing keys', () => {
    const first = render(<LangProvider catalogs={catalogs}><Probe /></LangProvider>);
    fireEvent.click(screen.getByText('Switch'));
    expect(screen.getByText('2 phambili')).toBeTruthy();
    expect(screen.getByText('Confirm')).toBeTruthy();
    expect(localStorage.getItem('mola:lang')).toBe('zu');
    expect(document.documentElement.lang).toBe('zu');
    first.unmount();
    render(<LangProvider catalogs={catalogs}><Probe /></LangProvider>);
    expect(screen.getByText('zu')).toBeTruthy();
  });
  it('uses the first available navigator language including regional tags', () => {
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['fr', 'zu-ZA', 'en']);
    render(<LangProvider catalogs={catalogs}><Probe /></LangProvider>);
    expect(screen.getByText('zu')).toBeTruthy();
  });
  it('ignores unavailable stored and navigator languages', () => {
    localStorage.setItem('mola:lang', 'af');
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['st']);
    render(<LangProvider catalogs={{ en }}><Probe /></LangProvider>);
    fireEvent.click(screen.getByText('Switch'));
    expect(screen.getByText('en')).toBeTruthy();
  });
  it('works when storage reads and writes throw', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    render(<LangProvider catalogs={catalogs}><Probe /></LangProvider>);
    fireEvent.click(screen.getByText('Switch'));
    expect(screen.getByText('zu')).toBeTruthy();
  });
  it('prefers a saved language over the navigator', () => {
    localStorage.setItem('mola:lang', 'en');
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['zu']);
    render(<LangProvider catalogs={catalogs}><Probe /></LangProvider>);
    expect(screen.getByText('en')).toBeTruthy();
  });
});

describe('language menu', () => {
  it('hides the chip with only English', () => {
    render(<LangProvider catalogs={{ en }}><LanguageMenu /></LangProvider>);
    expect(screen.queryByRole('button')).toBeNull();
  });
  it('offers available languages as radio items and changes the choice', async () => {
    render(<LangProvider catalogs={catalogs}><LanguageMenu /></LangProvider>);
    fireEvent.keyDown(screen.getByRole('button', { name: 'English' }), { key: 'ArrowDown' });
    const english = await screen.findByRole('menuitemradio', { name: 'English' });
    expect(english.getAttribute('aria-checked')).toBe('true');
    expect(screen.queryByRole('menuitemradio', { name: 'Afrikaans' })).toBeNull();
    expect(screen.getByText('Translations by Amazon Nova.')).toBeTruthy();
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'isiZulu' }));
    expect(screen.getByRole('button', { name: 'isiZulu' })).toBeTruthy();
    expect(localStorage.getItem('mola:lang')).toBe('zu');
  });
});

it('renders a non-English waiting position using only fixture numbers', () => {
  localStorage.setItem('mola:lang', 'zu');
  const ticket: TicketView = { ticketNo: 42, status: 'waiting', position: 3, desk: null, deadline: null, misses: 0 };
  const board: Board = {
    officeId: 'clinic', calling: [], serving: [], waitingCount: 3, upNext: [42], serverTime: Date.now(),
    rules: { confirmWindowSeconds: 120, dropBackPlaces: 3, maxMisses: 2 },
  };
  const { container } = render(
    <LangProvider catalogs={catalogs}>
      <PatronView
        officeId="clinic"
        ticket={ticket}
        board={board}
        receivedAt={Date.now()}
        online
        resuming={false}
        joining={false}
        tooLate={false}
        lastUpdateAt={Date.now()}
        onJoin={vi.fn()}
        onConfirm={vi.fn()}
        onLeave={vi.fn()}
      />
    </LangProvider>,
  );
  expect(screen.getByText('Inombolo 3.')).toBeTruthy();
  expect(screen.queryByText(/3rd/)).toBeNull();
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    for (const n of node.textContent?.match(/\d+/g) ?? []) expect(['42', '2', '3']).toContain(n);
  }
});

it('keeps every shipped catalog key and placeholder in parity with English', () => {
  const modules = import.meta.glob('../src/i18n/*.json', { eager: true, import: 'default' });
  const placeholders = (value: string) => [...new Set(value.match(/\{[^{}]+\}/g) ?? [])].sort();
  for (const catalog of Object.values(modules) as Record<string, unknown>[]) {
    expect(Object.keys(catalog).filter((key) => key !== '_meta').sort()).toEqual(Object.keys(en).sort());
    for (const [key, value] of Object.entries(en)) {
      expect(typeof catalog[key]).toBe('string');
      expect(placeholders(catalog[key] as string)).toEqual(placeholders(value));
    }
  }
});
