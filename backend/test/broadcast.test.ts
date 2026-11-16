import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { broadcast } from '../src/lib/broadcast';
import { deleteScreen, loadOffice, removeTicketConnection } from '../src/lib/db';
import type { Board } from '../src/lib/messages';
import type { OfficeSnapshot, Ticket } from '../src/lib/model';
import { send } from '../src/lib/ws';

vi.mock('../src/lib/db', () => ({ loadOffice: vi.fn(), removeTicketConnection: vi.fn(), deleteScreen: vi.fn() }));
vi.mock('../src/lib/ws', () => ({ send: vi.fn() }));

const nowMs = 1_800_000_000_500;
const rules: Board['rules'] = { confirmWindowSeconds: 30, dropBackPlaces: 3, maxMisses: 2 };
function ticket(ticketNo: number, overrides: Partial<Ticket> = {}): Ticket {
  return {
    officeId: 'demo', ticketNo, status: 'waiting', queueKey: ticketNo,
    secretHash: randomUUID(), connectionId: `phone-${ticketNo}`, misses: 0,
    createdAt: new Date(nowMs).toISOString(), expiresAt: nowMs / 1000 + 3600, ...overrides,
  };
}
function snapshot(tickets: Ticket[] = [], screenIds: string[] = []): OfficeSnapshot {
  return { office: null, tickets, screens: screenIds.map(connectionId => ({
    officeId: 'demo', connectionId, expiresAt: nowMs / 1000 + 3600,
  })) };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(Date, 'now').mockReturnValue(nowMs);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.mocked(send).mockResolvedValue('sent');
  vi.mocked(removeTicketConnection).mockResolvedValue(undefined);
  vi.mocked(deleteScreen).mockResolvedValue(undefined);
  vi.mocked(loadOffice).mockResolvedValue(snapshot());
});
afterEach(() => { vi.restoreAllMocks(); });

describe('broadcast', () => {
  it('loads once and sends a status for every connected ticket, including terminal statuses, and boards to all screens', async () => {
    const statuses: Ticket['status'][] = ['waiting', 'called', 'serving', 'done', 'left', 'no_show'];
    vi.mocked(loadOffice).mockResolvedValue(snapshot([
      ...statuses.map((status, i) => ticket(i + 1, {
        status, desk: 'Desk 1', ...(status === 'called' ? { taskToken: randomUUID(), deadline: nowMs + 30_000 } : {}),
      })), ticket(7, { connectionId: undefined, queueKey: 0 }),
    ], ['screen-a', 'screen-b']));
    await expect(broadcast('demo', rules)).resolves.toBeUndefined();
    expect(loadOffice).toHaveBeenCalledExactlyOnceWith('demo');
    const board: Board = {
      officeId: 'demo', notesVersion: 0, calling: [{ ticketNo: 2, desk: 'Desk 1', deadline: nowMs + 30_000 }],
      serving: [{ ticketNo: 3, desk: 'Desk 1' }], waitingCount: 2, upNext: [7, 1], serverTime: nowMs, rules,
    };
    expect(send).toHaveBeenCalledTimes(8);
    for (const [i, status] of statuses.entries()) {
      expect(send).toHaveBeenCalledWith(`phone-${i + 1}`, { type: 'status', board, ticket: {
        ticketNo: i + 1, status, position: status === 'waiting' ? 2 : null,
        desk: status === 'called' || status === 'serving' ? 'Desk 1' : null,
        deadline: status === 'called' ? nowMs + 30_000 : null, misses: 0,
      } });
    }
    for (const id of ['screen-a', 'screen-b']) expect(send).toHaveBeenCalledWith(id, { type: 'board', board });
  });

  it('sends an empty board without a META item', async () => {
    vi.mocked(loadOffice).mockResolvedValue(snapshot([], ['screen']));
    await broadcast('demo', rules);
    expect(send).toHaveBeenCalledExactlyOnceWith('screen', { type: 'board', board: {
      officeId: 'demo', notesVersion: 0, calling: [], serving: [], waitingCount: 0, upNext: [], serverTime: nowMs, rules,
    } });
  });

  it('does not send status to a called ticket expiring at the board timestamp but still sends the screen board', async () => {
    vi.mocked(loadOffice).mockResolvedValue(snapshot([ticket(1, {
      status: 'called', desk: 'Desk 1', taskToken: randomUUID(),
      deadline: nowMs + 30_000, expiresAt: nowMs / 1000,
    })], ['screen']));
    await broadcast('demo', rules);
    expect(send).toHaveBeenCalledExactlyOnceWith('screen', { type: 'board', board: {
      officeId: 'demo', notesVersion: 0, calling: [], serving: [], waitingCount: 0, upNext: [], serverTime: nowMs, rules,
    } });
    expect(removeTicketConnection).not.toHaveBeenCalled();
  });

  it('removes exactly gone ticket and screen connections while all other recipients still receive', async () => {
    vi.mocked(loadOffice).mockResolvedValue(snapshot([ticket(1), ticket(2)], ['gone-screen', 'live-screen']));
    vi.mocked(send).mockImplementation(id => Promise.resolve(id === 'phone-1' || id === 'gone-screen' ? 'gone' : 'sent'));
    await broadcast('demo', rules);
    expect(send).toHaveBeenCalledTimes(4);
    expect(removeTicketConnection).toHaveBeenCalledExactlyOnceWith('demo', 1, 'phone-1');
    expect(deleteScreen).toHaveBeenCalledExactlyOnceWith('demo', 'gone-screen');
  });

  it('logs failed posts with their connection ID and still sends to later recipients', async () => {
    const error = new Error('post failed');
    vi.mocked(loadOffice).mockResolvedValue(snapshot(Array.from({ length: 30 }, (_, i) => ticket(i + 1)), ['screen']));
    vi.mocked(send).mockRejectedValueOnce(error);
    await expect(broadcast('demo', rules)).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(31);
    expect(console.error).toHaveBeenCalledWith(expect.any(String), 'phone-1', error);
    expect(removeTicketConnection).not.toHaveBeenCalled();
    expect(deleteScreen).not.toHaveBeenCalled();
  });

  it.each(['ticket', 'screen'] as const)('contains and logs a failed gone %s cleanup', async kind => {
    const error = new Error('cleanup failed');
    vi.mocked(loadOffice).mockResolvedValue(snapshot([ticket(1)], ['screen']));
    vi.mocked(send).mockResolvedValue('gone');
    if (kind === 'ticket') vi.mocked(removeTicketConnection).mockRejectedValue(error);
    else vi.mocked(deleteScreen).mockRejectedValue(error);
    await expect(broadcast('demo', rules)).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(2);
    expect(console.error).toHaveBeenCalledWith(expect.any(String), kind === 'ticket' ? 'phone-1' : 'screen', error);
  });

  it('contains and logs a snapshot read failure', async () => {
    const error = new Error('read failed');
    vi.mocked(loadOffice).mockRejectedValue(error);
    await expect(broadcast('demo', rules)).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledWith(expect.any(String), 'demo', error);
    expect(send).not.toHaveBeenCalled();
  });

  it('keeps at most 25 sends in flight across phones and screens and waits for all sends', async () => {
    vi.mocked(loadOffice).mockResolvedValue(snapshot(
      Array.from({ length: 30 }, (_, i) => ticket(i + 1)),
      Array.from({ length: 30 }, (_, i) => `screen-${i}`),
    ));
    let active = 0;
    let peak = 0;
    const releases: (() => void)[] = [];
    vi.mocked(send).mockImplementation(() => new Promise<'sent'>(resolve => {
      active++;
      peak = Math.max(peak, active);
      releases.push(() => { active--; resolve('sent'); });
    }));
    let finished = false;
    const pending = broadcast('demo', rules).then(() => { finished = true; });
    await vi.waitFor(() => { expect(send).toHaveBeenCalledTimes(25); });
    expect(finished).toBe(false);
    while (!finished) {
      for (const release of releases.splice(0)) release();
      await new Promise(resolve => setImmediate(resolve));
    }
    await pending;
    expect(peak).toBe(25);
    expect(active).toBe(0);
    expect(send).toHaveBeenCalledTimes(60);
  });
});
