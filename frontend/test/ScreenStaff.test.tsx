import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Board, ServerMessage } from '../src/lib/messages';

const fake = vi.hoisted(() => ({
  opts: null as null | { onMessage(m: unknown): void; onState(s: string): void; onOpen(): void },
  sent: [] as unknown[],
}));
vi.mock('../src/lib/socket', () => ({
  createSocket: (_url: string, opts: typeof fake.opts) => {
    fake.opts = opts;
    return { send: (m: unknown) => fake.sent.push(m), close: () => undefined };
  },
}));

const { ScreenApp } = await import('../src/screen/ScreenApp');

const rules = { confirmWindowSeconds: 120, dropBackPlaces: 3, maxMisses: 2 };
const board = (over: Partial<Board> = {}): Board =>
  ({ officeId: 'demo', calling: [], serving: [], waitingCount: 2, upNext: [7, 8], serverTime: Date.now(), rules, ...over });
const open = () => act(() => { fake.opts?.onState('open'); fake.opts?.onOpen(); });
const receive = (m: ServerMessage) => act(() => fake.opts?.onMessage(m));
const key = 'a-staff-key-for-tests';

beforeEach(() => {
  fake.opts = null;
  fake.sent = [];
  localStorage.clear();
  sessionStorage.clear();
  window.history.replaceState(null, '', '/screen?office=demo&staff=1');
});
afterEach(cleanup);

function ready() {
  render(<ScreenApp />);
  open();
  receive({ type: 'board', board: board() });
}

describe('staff controls', () => {
  it('shows no staff controls in display mode', () => {
    window.history.replaceState(null, '', '/screen?office=demo');
    ready();
    expect(screen.queryByRole('button', { name: 'Call next' })).toBeNull();
  });

  it('asks for the staff key first, then calls next for this desk', () => {
    ready();
    fireEvent.click(screen.getByRole('button', { name: 'Call next' }));
    fireEvent.change(screen.getByLabelText('Staff key'), { target: { value: key } });
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    expect(fake.sent).toContainEqual({ action: 'callNext', desk: 'Desk 1', staffKey: key });
  });

  it('remembers the desk name for this office', () => {
    ready();
    fireEvent.change(screen.getByLabelText('This desk'), { target: { value: 'Desk 3' } });
    expect(localStorage.getItem('mola:desk:demo')).toBe('Desk 3');
  });

  it('holds Call next until the server answers', () => {
    sessionStorage.setItem('mola:staff:demo', key);
    ready();
    fireEvent.click(screen.getByRole('button', { name: 'Call next' }));
    expect((screen.getByRole('button', { name: 'Call next' }) as HTMLButtonElement).disabled).toBe(true);
    receive({ type: 'board', board: board({ calling: [{ ticketNo: 7, desk: 'Desk 1', deadline: null }] }) });
    expect((screen.getByRole('button', { name: 'Call next' }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText('Called 7 to Desk 1.')).toBeTruthy();
  });

  it('ignores an unrelated board while the call is pending', () => {
    sessionStorage.setItem('mola:staff:demo', key);
    ready();
    fireEvent.click(screen.getByRole('button', { name: 'Call next' }));
    receive({ type: 'board', board: board({ calling: [{ ticketNo: 5, desk: 'Desk 2', deadline: null }] }) });
    expect((screen.getByRole('button', { name: 'Call next' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('locks the desk name while a call is pending, so the answer still matches', () => {
    sessionStorage.setItem('mola:staff:demo', key);
    ready();
    fireEvent.click(screen.getByRole('button', { name: 'Call next' }));
    expect((screen.getByLabelText('This desk') as HTMLInputElement).disabled).toBe(true);
    receive({ type: 'board', board: board({ calling: [{ ticketNo: 7, desk: 'Desk 1', deadline: null }] }) });
    expect((screen.getByLabelText('This desk') as HTMLInputElement).disabled).toBe(false);
  });

  it('re-enables Call next when the socket reopens', () => {
    sessionStorage.setItem('mola:staff:demo', key);
    ready();
    fireEvent.click(screen.getByRole('button', { name: 'Call next' }));
    open();
    expect((screen.getByRole('button', { name: 'Call next' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('sends nothing for a desk name the server would refuse', () => {
    sessionStorage.setItem('mola:staff:demo', key);
    ready();
    fireEvent.change(screen.getByLabelText('This desk'), { target: { value: 'Desk #1!' } });
    fireEvent.click(screen.getByRole('button', { name: 'Call next' }));
    expect(fake.sent.filter((m) => (m as { action: string }).action === 'callNext')).toEqual([]);
  });

  it('keeps the key out of localStorage', () => {
    ready();
    fireEvent.click(screen.getByRole('button', { name: 'Call next' }));
    fireEvent.change(screen.getByLabelText('Staff key'), { target: { value: key } });
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    expect(JSON.stringify({ ...localStorage })).not.toContain(key);
  });

  it('says when nobody is waiting', () => {
    sessionStorage.setItem('mola:staff:demo', key);
    ready();
    fireEvent.click(screen.getByRole('button', { name: 'Call next' }));
    receive({ type: 'notice', code: 'queue_empty' });
    expect(screen.getAllByText('Nobody is waiting.').length).toBeGreaterThan(0);
  });

  it('says the desk is still calling someone', () => {
    sessionStorage.setItem('mola:staff:demo', key);
    ready();
    receive({ type: 'board', board: board({ calling: [{ ticketNo: 7, desk: 'Desk 1', deadline: null }] }) });
    fireEvent.click(screen.getByRole('button', { name: 'Call next' }));
    receive({ type: 'error', code: 'desk_busy', message: 'x' });
    expect(screen.getByText('Desk 1 is still calling 7.')).toBeTruthy();
  });

  it('forgets a wrong key and asks again with the error', () => {
    sessionStorage.setItem('mola:staff:demo', 'wrong-key-123');
    ready();
    fireEvent.click(screen.getByRole('button', { name: 'Call next' }));
    receive({ type: 'error', code: 'forbidden', message: 'x' });
    expect(sessionStorage.getItem('mola:staff:demo')).toBeNull();
    expect(screen.getByText("That key didn't work. Check it and try again.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Staff key'), { target: { value: key } });
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    expect(fake.sent).toContainEqual({ action: 'callNext', desk: 'Desk 1', staffKey: key });
  });
});
