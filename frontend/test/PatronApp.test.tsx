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

function openAsk() {
  localStorage.setItem('mola:demo', JSON.stringify({ ticketNo: 7, secret }));
  render(<PatronApp />);
  open();
  receive({ type: 'status', ticket: ticket(), board });
  fireEvent.click(screen.getByRole('button', { name: 'Ask the office' }));
}
function ask(question = 'What should I bring?') {
  fireEvent.change(screen.getByLabelText('Your question'), { target: { value: question } });
  fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
}

describe('office questions', () => {
  it('loads notes, trims questions, blocks concurrent asks and renders the server answer', () => {
    openAsk();
    expect(sent()).toContainEqual({ action: 'notes', lang: 'en' });
    receive({ type: 'notes', lang: 'en', version: 0, text: 'Bring your ID.', translated: true });
    expect(screen.getByText('Bring your ID.')).toBeTruthy();
    expect(screen.getByText('Translated by Amazon Nova.')).toBeTruthy();
    ask('  What should I bring?  ');
    expect(sent()).toContainEqual({ action: 'ask', ticketNo: 7, secret, question: 'What should I bring?', lang: 'en' });
    expect((screen.getByRole('button', { name: 'Checking the notes…' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.submit(screen.getByLabelText('Your question').closest('form') as HTMLFormElement);
    expect(sent().filter((m) => m.action === 'ask')).toHaveLength(1);
    receive({ type: 'answer', question: 'Server question', found: true, answer: 'Your green ID book.', asksLeft: 1 });
    expect(screen.getByText('Server question')).toBeTruthy();
    expect(screen.getByText('Your green ID book.')).toBeTruthy();
    expect(screen.getByText("From the office's notes")).toBeTruthy();
    expect(screen.getByText('Answered by Amazon Nova. Check anything important at the desk.')).toBeTruthy();
    expect(screen.getByText('1 question left on this ticket.')).toBeTruthy();
  });

  it('renders not found, unavailable and limit, retaining the thread across close and open', () => {
    openAsk();
    receive({ type: 'notes', lang: 'en', version: 0, text: '', translated: false });
    expect(screen.getByText("The office hasn't added notes yet.")).toBeTruthy();
    ask();
    receive({ type: 'answer', question: 'What should I bring?', found: false, answer: null, asksLeft: 9 });
    expect(screen.getByText("The notes don't cover that. Ask at the desk when you're called.")).toBeTruthy();
    expect(screen.getByText('9 questions left on this ticket.')).toBeTruthy();
    ask('Are you open?');
    receive({ type: 'error', code: 'assist_unavailable', message: 'x' });
    expect(screen.getByText("The assistant isn't available right now. Ask at the desk.")).toBeTruthy();
    ask('Can I return?');
    receive({ type: 'error', code: 'ask_limit', message: 'x' });
    expect(screen.getByText("You've used all your questions for this ticket. Ask at the desk.")).toBeTruthy();
    expect((screen.getByLabelText('Your question') as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ask the office' }));
    expect(screen.getByText('Are you open?')).toBeTruthy();
    expect((screen.getByLabelText('Your question') as HTMLInputElement).disabled).toBe(true);
  });

  it('refetches notes on changed board versions and each open, and stays open when called', () => {
    openAsk();
    receive({ type: 'notes', lang: 'en', version: 0, text: 'Original', translated: false });
    receive({ type: 'board', board: { ...board, notesVersion: 2 } });
    expect(sent().filter((m) => m.action === 'notes')).toHaveLength(2);
    receive({ type: 'notes', lang: 'en', version: 2, text: 'Updated', translated: false });
    receive({ type: 'status', ticket: ticket({ status: 'called', desk: 'Desk 1' }), board: { ...board, notesVersion: 2 } });
    expect(screen.getByRole('dialog', { name: 'Ask the office' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('button', { name: 'Ask the office' })).toBeNull();
    receive({ type: 'status', ticket: ticket({ status: 'serving', desk: 'Desk 1' }), board: { ...board, notesVersion: 2 } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask the office' }));
    expect(sent().filter((m) => m.action === 'notes')).toHaveLength(3);
  });
});
