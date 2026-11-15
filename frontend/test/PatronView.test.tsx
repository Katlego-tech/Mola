import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Board, TicketView } from '../src/lib/messages';
import { PatronView, type PatronViewProps } from '../src/patron/PatronView';

afterEach(cleanup);

const rules = { confirmWindowSeconds: 120, dropBackPlaces: 3, maxMisses: 2 };
const board: Board = {
  officeId: 'soweto-clinic',
  calling: [{ ticketNo: 38, desk: 'Desk 1', deadline: null }],
  serving: [],
  waitingCount: 5,
  upNext: [40, 41, 42, 43, 44],
  serverTime: 1_000_000,
  rules,
};
const waiting: TicketView = { ticketNo: 42, status: 'waiting', position: 3, desk: null, deadline: null, misses: 0 };

function view(overrides: Partial<PatronViewProps> = {}) {
  const props: PatronViewProps = {
    officeId: 'soweto-clinic',
    ticket: waiting,
    board,
    receivedAt: Date.now(),
    online: true,
    resuming: false,
    joining: false,
    tooLate: false,
    lastUpdateAt: Date.now(),
    onJoin: vi.fn(),
    onConfirm: vi.fn(),
    onLeave: vi.fn(),
    ...overrides,
  };
  render(<PatronView {...props} />);
  return props;
}

/** Every run of digits on the page must be one the server sent (Non-negotiable 1). */
function numbersOnPage(): string[] {
  const found: string[] = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    found.push(...(node.textContent?.match(/\d+/g) ?? []));
  }
  return found;
}

describe('PatronView', () => {
  it('offers a number when there is no ticket', () => {
    const props = view({ ticket: null, board: null });
    fireEvent.click(screen.getByRole('button', { name: 'Get a number' }));
    expect(props.onJoin).toHaveBeenCalledOnce();
  });

  it('disables Get a number while a join is in flight', () => {
    view({ ticket: null, board: null, joining: true });
    expect((screen.getByRole('button', { name: 'Get a number' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('says it is finding the ticket while a resume is pending', () => {
    view({ ticket: null, board: null, resuming: true });
    expect(screen.getByText('Finding your ticket')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Get a number' })).toBeNull();
  });

  it('shows the waiting ticket with only server numbers', () => {
    view();
    expect(screen.getByText('42')).toBeTruthy();
    expect(screen.getByText('2 people ahead')).toBeTruthy();
    expect(screen.getByText("You're 3rd in line.")).toBeTruthy();
    expect(screen.getByText(/38 at Desk 1/)).toBeTruthy();
    for (const n of numbersOnPage()) expect(['42', '2', '3', '38', '1']).toContain(n);
  });

  it('explains a missed turn with the office rules, and warns on the last one', () => {
    view({ ticket: { ...waiting, misses: 2 } });
    expect(screen.getByText('You missed your turn')).toBeTruthy();
    expect(screen.getByText(/moved back 3 places/)).toBeTruthy();
    expect(screen.getByText(/One more missed turn closes your ticket/)).toBeTruthy();
  });

  it('turns the whole screen into the call, with a countdown from the server deadline', () => {
    const props = view({
      ticket: { ...waiting, status: 'called', position: null, desk: 'Desk 2', deadline: 1_000_000 + 102_000 },
    });
    expect(screen.getByText('Desk 2')).toBeTruthy();
    expect(screen.getByText('1:42')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(props.onConfirm).toHaveBeenCalledOnce();
  });

  it('holds Confirm until the call has a deadline', () => {
    view({ ticket: { ...waiting, status: 'called', position: null, desk: 'Desk 2', deadline: null } });
    expect((screen.getByRole('button', { name: 'Confirm' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('confirms being served at the desk', () => {
    view({ ticket: { ...waiting, status: 'serving', position: null, desk: 'Desk 2' } });
    expect(screen.getByText('Confirmed. Desk 2 is expecting you.')).toBeTruthy();
  });

  it.each([
    ['done', "You've been seen"],
    ['no_show', 'This ticket has closed'],
    ['left', "You've left the queue"],
  ] as const)('closes a %s ticket and offers a new number', (status, text) => {
    const props = view({ ticket: { ...waiting, status, position: null } });
    expect(screen.getByText(text)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Get a new number' }));
    expect(props.onJoin).toHaveBeenCalledOnce();
  });

  it('says the time ran out when a confirm arrives too late', () => {
    view({ ticket: { ...waiting, misses: 1 }, tooLate: true });
    expect(screen.getByText('Your time to confirm ran out')).toBeTruthy();
  });

  it('keeps the last ticket on screen while reconnecting', () => {
    view({ online: false, lastUpdateAt: Date.now() - 12_000 });
    expect(screen.getByText('Reconnecting. Your place is kept.')).toBeTruthy();
    expect(screen.getByText('42')).toBeTruthy();
  });

  it('asks before leaving, then leaves', () => {
    const props = view();
    fireEvent.click(screen.getByRole('button', { name: 'Leave the queue' }));
    expect(screen.getByText('Leave the queue?')).toBeTruthy();
    expect(props.onLeave).not.toHaveBeenCalled();
    const buttons = screen.getAllByRole('button', { name: 'Leave the queue' });
    fireEvent.click(buttons[buttons.length - 1] as HTMLElement);
    expect(props.onLeave).toHaveBeenCalledOnce();
  });
});
