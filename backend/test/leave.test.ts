import { createHash, randomUUID } from 'node:crypto';
import { SendTaskFailureCommand, SFNClient } from '@aws-sdk/client-sfn';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OfficeSnapshot, Ticket, TicketStatus } from '../src/lib/model';

const db = vi.hoisted(() => ({
  getConnection: vi.fn(), loadOffice: vi.fn(), markLeft: vi.fn(), finishServing: vi.fn(),
}));
const ws = vi.hoisted(() => ({ send: vi.fn() }));
const fanout = vi.hoisted(() => ({ broadcast: vi.fn() }));
vi.mock('../src/lib/db', () => db);
vi.mock('../src/lib/ws', () => ws);
vi.mock('../src/lib/broadcast', () => fanout);
const { handler } = await import('../src/handlers/client');
const sfn = mockClient(SFNClient);
const now = Date.parse('2027-03-01T08:00:00.123Z');
const nowIso = new Date(now).toISOString();
const officeRules = { confirmWindowSeconds: 120, dropBackPlaces: 3, maxMisses: 2 };
let secret: string;
let ticket: Ticket;
const event = (suppliedSecret = secret) => ({
  requestContext: { routeKey: 'leave', connectionId: 'phone' },
  body: JSON.stringify({ action: 'leave', ticketNo: 42, secret: suppliedSecret }),
});
const snapshot = (tickets: Ticket[]): OfficeSnapshot => ({ readAt: 1000, office: null, tickets, screens: [] });

beforeEach(() => {
  vi.resetAllMocks();
  sfn.reset();
  vi.useFakeTimers({ now });
  vi.stubEnv('CONFIRM_WINDOW_SECONDS', '120');
  vi.stubEnv('DROP_BACK_PLACES', '3');
  vi.stubEnv('MAX_MISSES', '2');
  secret = randomUUID();
  ticket = {
    officeId: 'demo', ticketNo: 42, status: 'waiting', queueKey: 42,
    secretHash: createHash('sha256').update(secret).digest('hex'), misses: 0,
    connectionId: 'old-phone', createdAt: nowIso, expiresAt: now / 1000 + 43200,
  };
  db.getConnection.mockResolvedValue({ connectionId: 'phone', officeId: 'demo', role: 'patron' });
  db.loadOffice.mockImplementation(() => Promise.resolve(snapshot([ticket])));
  ws.send.mockResolvedValue('sent');
  sfn.on(SendTaskFailureCommand).resolves({});
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

function expectBroadcast() {
  expect(fanout.broadcast).toHaveBeenCalledExactlyOnceWith('demo', officeRules);
  expect(ws.send).not.toHaveBeenCalled();
}

describe('leave', () => {
  it.each(['missing', 'wrong secret'])('refuses a %s ticket without writes or broadcast', async kind => {
    if (kind === 'missing') db.loadOffice.mockResolvedValue(snapshot([]));
    expect(await handler(event(kind === 'missing' ? secret : randomUUID()))).toEqual({ statusCode: 200 });
    expect(db.loadOffice).toHaveBeenCalledExactlyOnceWith('demo');
    expect(ws.send).toHaveBeenCalledExactlyOnceWith('phone', expect.objectContaining({ type: 'error', code: 'bad_ticket' }));
    expect(sfn.calls()).toHaveLength(0);
    expect(db.markLeft).not.toHaveBeenCalled();
    expect(db.finishServing).not.toHaveBeenCalled();
    expect(fanout.broadcast).not.toHaveBeenCalled();
  });

  it.each(['waiting', 'called'] as const)('marks a %s ticket without a token left, then broadcasts', async status => {
    ticket.status = status;
    expect(await handler(event())).toEqual({ statusCode: 200 });
    expect(db.loadOffice).toHaveBeenCalledExactlyOnceWith('demo');
    expect(db.markLeft).toHaveBeenCalledExactlyOnceWith('demo', 42, status, nowIso);
    expect(db.markLeft).toHaveBeenCalledBefore(fanout.broadcast);
    expect(db.finishServing).not.toHaveBeenCalled();
    expect(sfn.calls()).toHaveLength(0);
    expectBroadcast();
  });

  it('fails the called task with Patron.Left before marking left and broadcasting', async () => {
    ticket.status = 'called';
    ticket.taskToken = randomUUID();
    const started = Promise.withResolvers<undefined>();
    let complete: (() => void) | undefined;
    sfn.on(SendTaskFailureCommand).callsFake(() => new Promise<void>(resolve => {
      complete = resolve;
      started.resolve(undefined);
    }));
    const pending = handler(event());
    await started.promise;
    await vi.advanceTimersByTimeAsync(1000);
    expect(db.markLeft).not.toHaveBeenCalled();
    expect(fanout.broadcast).not.toHaveBeenCalled();
    complete?.();
    expect(await pending).toEqual({ statusCode: 200 });
    expect(sfn.commandCalls(SendTaskFailureCommand).map(call => call.args[0].input)).toEqual([
      { taskToken: ticket.taskToken, error: 'Patron.Left', cause: 'Patron left the queue' },
    ]);
    expect(db.loadOffice).toHaveBeenCalledExactlyOnceWith('demo');
    expect(db.markLeft).toHaveBeenCalledExactlyOnceWith('demo', 42, 'called', nowIso);
    expect(db.markLeft).toHaveBeenCalledBefore(fanout.broadcast);
    expect(db.finishServing).not.toHaveBeenCalled();
    expectBroadcast();
  });

  it('finishes a serving ticket, then broadcasts', async () => {
    ticket.status = 'serving';
    await handler(event());
    expect(db.finishServing).toHaveBeenCalledExactlyOnceWith('demo', 42, nowIso);
    expect(db.finishServing).toHaveBeenCalledBefore(fanout.broadcast);
    expect(db.markLeft).not.toHaveBeenCalled();
    expect(sfn.calls()).toHaveLength(0);
    expectBroadcast();
  });

  it.each<TicketStatus>(['done', 'left', 'no_show'])('only broadcasts for a %s ticket', async status => {
    ticket.status = status;
    await handler(event());
    expect(db.markLeft).not.toHaveBeenCalled();
    expect(db.finishServing).not.toHaveBeenCalled();
    expect(sfn.calls()).toHaveLength(0);
    expectBroadcast();
  });

  it.each<TicketStatus>(['waiting', 'called', 'serving', 'done', 'left', 'no_show'])(
    'TaskTimedOut re-reads once and applies leave to the new %s status without failing a second task', async status => {
      ticket.status = 'called';
      ticket.taskToken = randomUUID();
      sfn.on(SendTaskFailureCommand).rejects(Object.assign(new Error('Task closed'), { name: 'TaskTimedOut' }));
      db.loadOffice.mockResolvedValueOnce(snapshot([ticket])).mockResolvedValueOnce(snapshot([
        { ...ticket, ticketNo: 41, status: 'waiting' }, { ...ticket, status, taskToken: randomUUID() },
      ]));
      await handler(event());
      expect(db.loadOffice.mock.calls).toEqual([['demo'], ['demo']]);
      expect(sfn.commandCalls(SendTaskFailureCommand)).toHaveLength(1);
      if (status === 'waiting' || status === 'called') {
        expect(db.markLeft).toHaveBeenCalledExactlyOnceWith('demo', 42, status, nowIso);
      } else {
        expect(db.markLeft).not.toHaveBeenCalled();
      }
      if (status === 'serving') {
        expect(db.finishServing).toHaveBeenCalledExactlyOnceWith('demo', 42, nowIso);
      } else {
        expect(db.finishServing).not.toHaveBeenCalled();
      }
      expectBroadcast();
    },
  );

  it.each(['TaskDoesNotExist', 'InvalidToken'])('%s also re-reads the ticket', async name => {
    ticket.status = 'called';
    ticket.taskToken = randomUUID();
    sfn.on(SendTaskFailureCommand).rejects(Object.assign(new Error('Task closed'), { name }));
    db.loadOffice.mockResolvedValueOnce(snapshot([ticket])).mockResolvedValueOnce(snapshot([{ ...ticket, status: 'serving' }]));
    await handler(event());
    expect(db.loadOffice).toHaveBeenCalledTimes(2);
    expect(sfn.commandCalls(SendTaskFailureCommand)).toHaveLength(1);
    expect(db.markLeft).not.toHaveBeenCalled();
    expect(db.finishServing).toHaveBeenCalledExactlyOnceWith('demo', 42, nowIso);
    expectBroadcast();
  });

  it.each(['waiting', 'called', 'serving'] as const)('ignores a conditional failure writing %s and broadcasts', async status => {
    ticket.status = status;
    const write = status === 'serving' ? db.finishServing : db.markLeft;
    write.mockRejectedValue(Object.assign(new Error('Race lost'), { name: 'ConditionalCheckFailedException' }));
    await handler(event());
    expect(write).toHaveBeenCalledOnce();
    expectBroadcast();
  });

  it.each(['load', 'task', 'markLeft', 'finishServing', 'reload', 'broadcast'])('propagates other %s errors', async source => {
    const error = new Error('Unavailable');
    if (source === 'load') db.loadOffice.mockRejectedValue(error);
    if (source === 'task' || source === 'reload') {
      ticket.status = 'called';
      ticket.taskToken = randomUUID();
      sfn.on(SendTaskFailureCommand).rejects(source === 'task' ? error
        : Object.assign(new Error('Task closed'), { name: 'TaskTimedOut' }));
    }
    if (source === 'reload') db.loadOffice.mockResolvedValueOnce(snapshot([ticket])).mockRejectedValueOnce(error);
    if (source === 'markLeft') db.markLeft.mockRejectedValue(error);
    if (source === 'finishServing') {
      ticket.status = 'serving';
      db.finishServing.mockRejectedValue(error);
    }
    if (source === 'broadcast') fanout.broadcast.mockRejectedValue(error);
    await expect(handler(event())).rejects.toBe(error);
    if (source !== 'broadcast') expect(fanout.broadcast).not.toHaveBeenCalled();
  });
});
