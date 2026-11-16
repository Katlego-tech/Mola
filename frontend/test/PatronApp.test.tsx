import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Board, ClientMessage, ServerMessage, TicketView } from '../src/lib/messages';

// A fake socket: the test drives open/messages/state and reads what the page sent.
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
const alerts = vi.hoisted(() => ({ buzz: vi.fn(), chime: vi.fn(), unlockSound: vi.fn(), holdWakeLock: vi.fn() }));
vi.mock('../src/lib/alerts', () => alerts);

const { PatronApp } = await import('../src/patron/PatronApp');

const rules = { confirmWindowSeconds: 120, dropBackPlaces: 3, maxMisses: 2 };
const board: Board = { officeId: 'demo', notesVersion: 0, calling: [], serving: [], waitingCount: 1, upNext: [7], serverTime: Date.now(), rules };
const ticket = (over: Partial<TicketView> = {}): TicketView =>
  ({ ticketNo: 7, status: 'waiting', position: 1, desk: null, deadline: null, misses: 0, ...over });

const open = () => act(() => { fake.opts?.onState('open'); fake.opts?.onOpen(); });
const receive = (m: ServerMessage) => act(() => fake.opts?.onMessage(m));
const sent = () => fake.sent as ClientMessage[];
const secret = crypto.randomUUID();

beforeEach(() => {
  fake.opts = null;
  fake.sent = [];
  vi.resetAllMocks();
  alerts.holdWakeLock.mockResolvedValue(null);
  localStorage.clear();
  window.history.replaceState(null, '', '/?office=demo');
});
afterEach(cleanup);

describe('PatronApp', () => {
  it('resumes a stored ticket on every open', () => {
    localStorage.setItem('mola:demo', JSON.stringify({ ticketNo: 7, secret }));
    render(<PatronApp />);
    open();
    open();
    expect(sent()).toEqual([
      { action: 'resume', ticketNo: 7, secret },
      { action: 'resume', ticketNo: 7, secret },
    ]);
    expect(screen.getByText('Finding your ticket')).toBeTruthy();
  });

  it('joins once, keeps the secret, and shows the ticket when its status arrives', () => {
    render(<PatronApp />);
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Get a number' }));
    expect(sent()).toEqual([{ action: 'join' }]);
    receive({ type: 'ticket', officeId: 'demo', ticketNo: 7, secret });
    expect(JSON.parse(localStorage.getItem('mola:demo') ?? 'null')).toEqual({ ticketNo: 7, secret });
    receive({ type: 'status', ticket: ticket(), board });
    expect(screen.getByText("You're next")).toBeTruthy();
  });

  it('lets the patron try again when the socket drops before the ticket arrives', () => {
    render(<PatronApp />);
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Get a number' }));
    act(() => fake.opts?.onState('backoff'));
    open();
    expect((screen.getByRole('button', { name: 'Get a number' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('recovers when API Gateway answers a join with its own error (a throttled Lambda)', () => {
    render(<PatronApp />);
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Get a number' }));
    act(() => fake.opts?.onMessage({ message: 'Internal server error', connectionId: 'x', requestId: 'y' }));
    expect((screen.getByRole('button', { name: 'Get a number' }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText('Something went wrong on our side. Try again.')).toBeTruthy();
  });

  it('retries a resume that API Gateway failed, and says so meanwhile', () => {
    vi.useFakeTimers();
    try {
      localStorage.setItem('mola:demo', JSON.stringify({ ticketNo: 7, secret }));
      render(<PatronApp />);
      open();
      act(() => fake.opts?.onMessage({ message: 'Internal server error' }));
      expect(screen.getByText('Something went wrong on our side. Try again.')).toBeTruthy();
      act(() => { vi.advanceTimersByTime(2000); });
      expect(sent().filter((m) => m.action === 'resume')).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears the failure line once the server reports the ticket again', () => {
    localStorage.setItem('mola:demo', JSON.stringify({ ticketNo: 7, secret }));
    render(<PatronApp />);
    open();
    receive({ type: 'status', ticket: ticket({ status: 'called', position: null, desk: 'Desk 1', deadline: board.serverTime + 60_000 }), board });
    act(() => fake.opts?.onMessage({ message: 'Internal server error' }));
    expect(screen.getByText('Something went wrong on our side. Try again.')).toBeTruthy();
    receive({ type: 'status', ticket: ticket({ status: 'done', position: null }), board });
    expect(screen.queryByText('Something went wrong on our side. Try again.')).toBeNull();
  });

  it('forgets the secret when the ticket closes', () => {
    localStorage.setItem('mola:demo', JSON.stringify({ ticketNo: 7, secret }));
    render(<PatronApp />);
    open();
    receive({ type: 'status', ticket: ticket({ status: 'done', position: null }), board });
    expect(localStorage.getItem('mola:demo')).toBeNull();
    expect(screen.getByText("You've been seen")).toBeTruthy();
  });

  it('forgets a secret the server does not recognise and offers a new number', () => {
    localStorage.setItem('mola:demo', JSON.stringify({ ticketNo: 7, secret }));
    render(<PatronApp />);
    open();
    receive({ type: 'error', code: 'bad_ticket', message: 'x' });
    expect(localStorage.getItem('mola:demo')).toBeNull();
    expect(screen.getByRole('button', { name: 'Get a number' })).toBeTruthy();
  });

  it('buzzes and chimes once when the ticket is called, not on every update', () => {
    localStorage.setItem('mola:demo', JSON.stringify({ ticketNo: 7, secret }));
    render(<PatronApp />);
    open();
    receive({ type: 'status', ticket: ticket(), board });
    const called = ticket({ status: 'called', position: null, desk: 'Desk 1', deadline: board.serverTime + 60_000 });
    receive({ type: 'status', ticket: called, board });
    receive({ type: 'status', ticket: called, board });
    expect(alerts.buzz).toHaveBeenCalledOnce();
    expect(alerts.chime).toHaveBeenCalledOnce();
    expect(screen.getByRole('alert')).toBeTruthy();
  });

  it('takes the wake lock again when the page comes back into view', async () => {
    localStorage.setItem('mola:demo', JSON.stringify({ ticketNo: 7, secret }));
    render(<PatronApp />);
    open();
    receive({ type: 'status', ticket: ticket(), board });
    await act(async () => undefined);
    expect(alerts.holdWakeLock).toHaveBeenCalledOnce();
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(alerts.holdWakeLock).toHaveBeenCalledTimes(2);
  });

  it('cannot confirm once the deadline has passed', () => {
    localStorage.setItem('mola:demo', JSON.stringify({ ticketNo: 7, secret }));
    render(<PatronApp />);
    open();
    receive({ type: 'status', ticket: ticket({ status: 'called', position: null, desk: 'Desk 1', deadline: board.serverTime - 1 }), board });
    expect((screen.getByRole('button', { name: 'Confirm' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
