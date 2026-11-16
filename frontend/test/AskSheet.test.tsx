import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LangProvider, useT } from '../src/i18n';
import en from '../src/i18n/en.json';
import { AskSheet, type AskSheetHandle } from '../src/patron/AskSheet';

beforeEach(() => localStorage.clear());
afterEach(cleanup);
function Switch() {
  const { setLang } = useT();
  return <button onClick={() => setLang('zu')}>Switch</button>;
}

it('refetches for a language change and accepts English fallback notes verbatim', () => {
  const ref = createRef<AskSheetHandle>();
  const onNotes = vi.fn();
  render(<LangProvider catalogs={{ en, zu: {} }}><Switch /><AskSheet ref={ref} online notesVersion={3} onNotes={onNotes} onAsk={vi.fn()} /></LangProvider>);
  act(() => ref.current?.open());
  expect(onNotes).toHaveBeenLastCalledWith('en');
  act(() => ref.current?.receive({ type: 'notes', lang: 'en', version: 3, text: 'English notes', translated: false }));
  fireEvent.click(screen.getByText('Switch'));
  expect(onNotes).toHaveBeenLastCalledWith('zu');
  act(() => ref.current?.receive({ type: 'notes', lang: 'en', version: 3, text: 'Unchanged fallback notes', translated: false }));
  expect(screen.getByText('Unchanged fallback notes')).toBeTruthy();
  expect(screen.queryByText('Translated by Amazon Nova.')).toBeNull();
});

it('blocks blank questions and constrains the input length', () => {
  const ref = createRef<AskSheetHandle>();
  const onAsk = vi.fn();
  render(<LangProvider><AskSheet ref={ref} online notesVersion={0} onNotes={vi.fn()} onAsk={onAsk} /></LangProvider>);
  act(() => ref.current?.open());
  const input = screen.getByLabelText('Your question');
  expect(input.getAttribute('maxlength')).toBe('300');
  fireEvent.change(input, { target: { value: '   ' } });
  fireEvent.submit(input.closest('form') as HTMLFormElement);
  expect(onAsk).not.toHaveBeenCalled();
  fireEvent.change(input, { target: { value: 'a'.repeat(301) } });
  fireEvent.submit(input.closest('form') as HTMLFormElement);
  expect(onAsk).not.toHaveBeenCalled();
});

it('does not refetch when the board catches up to notes already held', () => {
  const ref = createRef<AskSheetHandle>();
  const onNotes = vi.fn();
  const onAsk = vi.fn();
  const view = (version: number) => <LangProvider><AskSheet ref={ref} online notesVersion={version} onNotes={onNotes} onAsk={onAsk} /></LangProvider>;
  const mounted = render(view(1));
  act(() => ref.current?.open());
  act(() => ref.current?.receive({ type: 'notes', lang: 'en', version: 2, text: 'Latest notes', translated: false }));
  mounted.rerender(view(2));
  expect(onNotes).toHaveBeenCalledTimes(1);
});


it('ignores notes for a superseded language and accepts only the English fallback', () => {
  const ref = createRef<AskSheetHandle>();
  render(<LangProvider catalogs={{ en, zu: {} }}><Switch /><AskSheet ref={ref} online notesVersion={3} onNotes={vi.fn()} onAsk={vi.fn()} /></LangProvider>);
  act(() => ref.current?.open());
  fireEvent.click(screen.getByText('Switch'));
  act(() => ref.current?.receive({ type: 'notes', lang: 'en', version: 3, text: 'Stale English translation', translated: true }));
  expect(screen.queryByText('Stale English translation')).toBeNull();
  act(() => ref.current?.receive({ type: 'notes', lang: 'st', version: 3, text: 'Other language', translated: false }));
  expect(screen.queryByText('Other language')).toBeNull();
  act(() => ref.current?.receive({ type: 'notes', lang: 'zu', version: 3, text: 'Current language', translated: true }));
  expect(screen.getByText('Current language')).toBeTruthy();
});
