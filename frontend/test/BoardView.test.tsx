import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Board } from '../src/lib/messages';
import { BoardView } from '../src/screen/BoardView';

afterEach(cleanup);

const rules = { confirmWindowSeconds: 120, dropBackPlaces: 3, maxMisses: 2 };
const base: Board = {
  officeId: 'soweto-clinic', notesVersion: 0, calling: [], serving: [], waitingCount: 0, upNext: [], serverTime: 1_000_000, rules,
};

function renderBoard(board: Board, receivedAt = 0) {
  return render(<BoardView board={board} receivedAt={receivedAt} joinUrl="https://example.test/?office=soweto-clinic" reconnecting={false} />);
}

describe('BoardView', () => {
  it('shows the empty state with the office name and no calling list', () => {
    renderBoard(base);
    expect(screen.getByText('Nobody is waiting.')).toBeTruthy();
    expect(screen.getByText('Soweto Clinic')).toBeTruthy();
    expect(screen.queryByText('Now calling')).toBeNull();
    expect(screen.getByText('people waiting')).toBeTruthy();
  });

  it('renders exactly the calling, serving and up-next tickets in the message', () => {
    renderBoard({
      ...base,
      calling: [{ ticketNo: 42, desk: 'Desk 2', deadline: 1_000_000 + 102_000 }, { ticketNo: 41, desk: 'Desk 1', deadline: null }],
      serving: [{ ticketNo: 39, desk: 'Desk 3' }],
      waitingCount: 1,
      upNext: [43],
    }, Date.now());
    expect(screen.getByText('42')).toBeTruthy();
    expect(screen.getByText('Desk 2')).toBeTruthy();
    expect(screen.getByText('1:42 left to confirm')).toBeTruthy();
    expect(screen.getByText('Calling now')).toBeTruthy();
    expect(screen.getByText('39')).toBeTruthy();
    expect(screen.getByText('person waiting')).toBeTruthy();
    expect(screen.getByText('43')).toBeTruthy();
    expect(screen.queryByText('Nobody is waiting.')).toBeNull();
  });

  it('says it is reconnecting instead of the office name while the socket is down', () => {
    render(<BoardView board={base} receivedAt={0} joinUrl="https://example.test/" reconnecting />);
    expect(screen.getByText('Reconnecting')).toBeTruthy();
  });
});
