import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { mockClient } from 'aws-sdk-client-mock';
import { broadcast, requestBroadcast } from '../src/lib/broadcast';
import { deleteScreen, loadOffice, removeTicketConnection } from '../src/lib/db';
import type { Board, ServerMessage } from '../src/lib/messages';
import type { OfficeSnapshot, Ticket } from '../src/lib/model';
import { send } from '../src/lib/ws';

vi.mock('../src/lib/db', () => ({ loadOffice: vi.fn(), removeTicketConnection: vi.fn(), deleteScreen: vi.fn() }));
vi.mock('../src/lib/ws', () => ({ send: vi.fn() }));

const sqs = mockClient(SQSClient);
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
  return { readAt: 1000, office: null, tickets, screens: screenIds.map(connectionId => ({
    officeId: 'demo', connectionId, trusted: false, expiresAt: nowMs / 1000 + 3600,
  })) };
}

beforeEach(() => {
  vi.resetAllMocks();
  sqs.reset();
  sqs.on(SendMessageCommand).resolves({});
  vi.stubEnv('BROADCAST_QUEUE_URL', 'https://sqs.af-south-1.amazonaws.com/queue/broadcast.fifo');
  vi.stubEnv('CONFIRM_WINDOW_SECONDS', '30');
  vi.stubEnv('DROP_BACK_PLACES', '3');
  vi.stubEnv('MAX_MISSES', '2');
  vi.spyOn(Date, 'now').mockReturnValue(nowMs);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.mocked(send).mockResolvedValue('sent');
  vi.mocked(removeTicketConnection).mockResolvedValue(undefined);
  vi.mocked(deleteScreen).mockResolvedValue(undefined);
  vi.mocked(loadOffice).mockResolvedValue(snapshot());
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

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
      serving: [{ ticketNo: 3, desk: 'Desk 1' }], waitingCount: 2, upNext: [7, 1], snapshotAt: 1000, serverTime: nowMs, rules,
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
      officeId: 'demo', notesVersion: 0, calling: [], serving: [], waitingCount: 0, upNext: [], snapshotAt: 1000, serverTime: nowMs, rules,
    } });
  });

  it('does not send status to a called ticket expiring at the board timestamp but still sends the screen board', async () => {
    vi.mocked(loadOffice).mockResolvedValue(snapshot([ticket(1, {
      status: 'called', desk: 'Desk 1', taskToken: randomUUID(),
      deadline: nowMs + 30_000, expiresAt: nowMs / 1000,
    })], ['screen']));
    await broadcast('demo', rules);
    expect(send).toHaveBeenCalledExactlyOnceWith('screen', { type: 'board', board: {
      officeId: 'demo', notesVersion: 0, calling: [], serving: [], waitingCount: 0, upNext: [], snapshotAt: 1000, serverTime: nowMs, rules,
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
    expect(console.error).toHaveBeenCalledWith(expect.any(String), 'phone-1', error.name);
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
    expect(console.error).toHaveBeenCalledWith(expect.any(String), kind === 'ticket' ? 'phone-1' : 'screen', error.name);
  });

  it('reports and logs a snapshot read failure', async () => {
    const error = new Error('read failed');
    vi.mocked(loadOffice).mockRejectedValue(error);
    await expect(broadcast('demo', rules)).rejects.toBe(error);
    expect(console.error).toHaveBeenCalledWith(expect.any(String), 'demo', error);
    expect(send).not.toHaveBeenCalled();
  });

  it('measures the read and send phases and counts attempted connections including failed deliveries', async () => {
    const metrics = { readMs: 0, sendMs: 0, connections: 0 };
    vi.mocked(loadOffice).mockImplementation(async () => {
      vi.mocked(Date.now).mockReturnValue(nowMs + 12);
      return snapshot([ticket(1)], ['screen']);
    });
    vi.mocked(send).mockImplementation(async () => {
      vi.mocked(Date.now).mockReturnValue(nowMs + 32);
      throw new Error('post failed');
    });
    await broadcast('demo', rules, metrics);
    expect(metrics).toEqual({ readMs: 12, sendMs: 20, connections: 2 });
  });

  it('records time spent on a failed read without counting sends', async () => {
    const metrics = { readMs: 0, sendMs: 0, connections: 0 };
    const error = new Error('read failed');
    vi.mocked(loadOffice).mockImplementation(async () => {
      vi.mocked(Date.now).mockReturnValue(nowMs + 15);
      throw error;
    });
    await expect(broadcast('demo', rules, metrics)).rejects.toBe(error);
    expect(metrics).toEqual({ readMs: 15, sendMs: 0, connections: 0 });
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


it('orders overlapping broadcasts by snapshot read time even when the older read finishes last', async () => {
  const oldRead = Promise.withResolvers<OfficeSnapshot>();
  vi.mocked(loadOffice).mockReturnValueOnce(oldRead.promise).mockResolvedValueOnce({
    ...snapshot([ticket(1, { status: 'called', taskToken: randomUUID(), deadline: nowMs + 30_000 })], ['screen']), readAt: nowMs + 10,
  });
  const older = broadcast('demo', rules);
  await broadcast('demo', rules);
  vi.mocked(Date.now).mockReturnValue(nowMs + 20);
  oldRead.resolve({ ...snapshot([ticket(1, { status: 'called' })], ['screen']), readAt: nowMs });
  await older;
  const messages = vi.mocked(send).mock.calls.map(([, message]) => message as ServerMessage);
  expect(messages.map(message => 'board' in message ? message.board.snapshotAt : null))
    .toEqual([nowMs + 10, nowMs + 10, nowMs, nowMs]);
  expect(messages.map(message => 'board' in message ? message.board.serverTime : null))
    .toEqual([nowMs, nowMs, nowMs + 20, nowMs + 20]);
});

describe('requestBroadcast', () => {
  it('enqueues each request with its office group, timestamp and a unique deduplication ID', async () => {
    await requestBroadcast('demo');
    await requestBroadcast('demo');
    const inputs = sqs.commandCalls(SendMessageCommand).map(call => call.args[0].input);
    expect(inputs).toHaveLength(2);
    for (const input of inputs) {
      expect(input).toEqual({
        QueueUrl: process.env.BROADCAST_QUEUE_URL,
        MessageGroupId: 'demo',
        MessageDeduplicationId: expect.stringMatching(new RegExp(`^demo:${nowMs}:[0-9a-f]{8}$`)),
        MessageBody: JSON.stringify({ officeId: 'demo', requestedAt: nowMs }),
      });
    }
    expect(inputs[0]?.MessageDeduplicationId).not.toBe(inputs[1]?.MessageDeduplicationId);
    expect(loadOffice).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('logs a send failure and falls back to a direct broadcast using current rules', async () => {
    const error = new Error('queue unavailable');
    sqs.on(SendMessageCommand).rejects(error);
    vi.mocked(loadOffice).mockResolvedValue(snapshot([], ['screen']));
    await expect(requestBroadcast('demo')).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledWith(expect.any(String), 'demo', error);
    expect(loadOffice).toHaveBeenCalledExactlyOnceWith('demo');
    expect(send).toHaveBeenCalledWith('screen', expect.objectContaining({
      board: expect.objectContaining({ rules }),
    }));
  });

  it('falls back when no queue URL is configured', async () => {
    vi.stubEnv('BROADCAST_QUEUE_URL', undefined);
    await requestBroadcast('demo');
    expect(sqs.calls()).toHaveLength(0);
    expect(loadOffice).toHaveBeenCalledExactlyOnceWith('demo');
  });

  it('contains a fallback failure so the completed action still succeeds', async () => {
    sqs.on(SendMessageCommand).rejects(new Error('queue unavailable'));
    vi.mocked(loadOffice).mockRejectedValue(new Error('read failed'));
    await expect(requestBroadcast('demo')).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalled();
  });
});

it('includes join information only on trusted screen board messages', async () => {
  const code = randomUUID().replaceAll('-', '').slice(0, 16);
  const state = snapshot([ticket(1)], ['trusted', 'public']);
  state.office = { officeId: 'demo', ticketCounter: 1, createdAt: new Date(nowMs).toISOString(), joinCode: code, joinCodeIssuedAt: nowMs };
  const trusted = state.screens[0];
  if (!trusted) throw new Error('Screen missing');
  trusted.trusted = true;
  vi.mocked(loadOffice).mockResolvedValue(state);
  await broadcast('demo', rules);
  expect(send).toHaveBeenCalledWith('trusted', expect.objectContaining({ join: { code, expiresAt: nowMs + 120_000 } }));
  for (const [id, message] of vi.mocked(send).mock.calls) {
    if (id !== 'trusted') expect(JSON.stringify(message)).not.toContain(code);
    const payload = message as ServerMessage;
    if (payload.type === 'status') {
      expect(payload).not.toHaveProperty('join');
      expect(payload.board).not.toHaveProperty('join');
    }
  }
});
