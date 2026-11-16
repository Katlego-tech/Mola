import { createHash, randomUUID } from 'node:crypto';
import { SendTaskSuccessCommand, SFNClient } from '@aws-sdk/client-sfn';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OfficeSnapshot, Ticket, TicketStatus } from '../src/lib/model';

const db = vi.hoisted(() => ({ getConnection: vi.fn(), loadOffice: vi.fn(), markServing: vi.fn() }));
const ws = vi.hoisted(() => ({ send: vi.fn() }));
const fanout = vi.hoisted(() => ({ broadcast: vi.fn() }));
vi.mock('../src/lib/db', () => db);
vi.mock('../src/lib/ws', () => ws);
vi.mock('../src/lib/broadcast', () => fanout);
const { handler } = await import('../src/handlers/client');
const sfn = mockClient(SFNClient);
const now = Date.parse('2027-03-01T08:00:00.123Z');
const officeRules = { confirmWindowSeconds: 120, dropBackPlaces: 3, maxMisses: 2 };
let secret: string;
let ticket: Ticket;
const event = (suppliedSecret = secret) => ({
  requestContext: { routeKey: 'confirm', connectionId: 'phone' },
  body: JSON.stringify({ action: 'confirm', ticketNo: 42, secret: suppliedSecret }),
});
const snapshot = (tickets: Ticket[]): OfficeSnapshot => ({ office: null, tickets, screens: [] });

beforeEach(() => {
  vi.resetAllMocks();
  sfn.reset();
  vi.useFakeTimers({ now });
  vi.stubEnv('CONFIRM_WINDOW_SECONDS', '120');
  vi.stubEnv('DROP_BACK_PLACES', '3');
  vi.stubEnv('MAX_MISSES', '2');
  secret = randomUUID();
  ticket = { officeId: 'demo', ticketNo: 42, status: 'called', queueKey: 42,
    secretHash: createHash('sha256').update(secret).digest('hex'), misses: 0,
    connectionId: 'old-phone', taskToken: randomUUID(), desk: 'Desk 2', deadline: now + 120000,
    createdAt: new Date(now).toISOString(), expiresAt: now / 1000 + 43200 };
  db.getConnection.mockResolvedValue({ connectionId: 'phone', officeId: 'demo', role: 'patron' });
  db.loadOffice.mockImplementation(() => Promise.resolve(snapshot([ticket])));
  ws.send.mockResolvedValue('sent');
  sfn.on(SendTaskSuccessCommand).resolves({});
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

function expectNoMutation() {
  expect(sfn.calls()).toHaveLength(0);
  expect(db.markServing).not.toHaveBeenCalled();
  expect(fanout.broadcast).not.toHaveBeenCalled();
}

describe('confirm', () => {
  it('succeeds the task with confirmedAt, marks serving, then broadcasts', async () => {
    expect(await handler(event())).toEqual({ statusCode: 200 });
    expect(db.loadOffice).toHaveBeenCalledExactlyOnceWith('demo');
    expect(sfn.commandCalls(SendTaskSuccessCommand).map(call => call.args[0].input)).toEqual([
      { taskToken: ticket.taskToken, output: JSON.stringify({ confirmedAt: new Date(now).toISOString() }) },
    ]);
    expect(db.markServing).toHaveBeenCalledExactlyOnceWith('demo', 42, new Date(now).toISOString());
    expect(db.markServing).toHaveBeenCalledBefore(fanout.broadcast);
    expect(fanout.broadcast).toHaveBeenCalledExactlyOnceWith('demo', officeRules);
    expect(ws.send).not.toHaveBeenCalled();
  });

  it.each(['TaskTimedOut', 'TaskDoesNotExist', 'InvalidToken'])('%s sends too_late without touching the ticket', async name => {
    sfn.on(SendTaskSuccessCommand).rejects(Object.assign(new Error('Task closed'), { name }));
    await handler(event());
    expect(ws.send).toHaveBeenCalledExactlyOnceWith('phone', { type: 'notice', code: 'too_late', ticketNo: 42 });
    expect(db.markServing).not.toHaveBeenCalled();
    expect(fanout.broadcast).not.toHaveBeenCalled();
  });

  it.each(['missing', 'wrong secret'])('refuses a %s ticket', async kind => {
    if (kind === 'missing') db.loadOffice.mockResolvedValue(snapshot([]));
    await handler(event(randomUUID()));
    expect(ws.send).toHaveBeenCalledExactlyOnceWith('phone', expect.objectContaining({ type: 'error', code: 'bad_ticket' }));
    expectNoMutation();
  });

  it.each<TicketStatus>(['waiting', 'no_show'])('sends too_late then this phone’s status for a missed %s ticket', async status => {
    ticket.status = status;
    ticket.misses = 1;
    delete ticket.taskToken;
    db.loadOffice.mockResolvedValue(snapshot([
      ticket, { ...ticket, ticketNo: 41, status: 'waiting', queueKey: 41 },
    ]));
    await handler(event());
    expect(ws.send.mock.calls).toEqual([
      ['phone', { type: 'notice', code: 'too_late', ticketNo: 42 }],
      ['phone', { type: 'status',
        ticket: { ticketNo: 42, status, position: status === 'waiting' ? 2 : null, desk: null, deadline: null, misses: 1 },
        board: { officeId: 'demo', notesVersion: 0, calling: [], serving: [], waitingCount: status === 'waiting' ? 2 : 1,
          upNext: status === 'waiting' ? [41, 42] : [41], serverTime: now, rules: officeRules } }],
    ]);
    expectNoMutation();
  });

  it.each<TicketStatus>(['waiting', 'called', 'serving', 'done', 'left', 'no_show'])('answers not_called for %s without an eligible task', async status => {
    ticket.status = status;
    delete ticket.taskToken;
    await handler(event());
    expect(ws.send).toHaveBeenCalledExactlyOnceWith('phone', expect.objectContaining({ type: 'error', code: 'not_called' }));
    expectNoMutation();
  });

  it('ignores a markServing conditional failure and broadcasts', async () => {
    db.markServing.mockRejectedValue(Object.assign(new Error('Race lost'), { name: 'ConditionalCheckFailedException' }));
    await handler(event());
    expect(fanout.broadcast).toHaveBeenCalledExactlyOnceWith('demo', officeRules);
  });

  it('waits for task success before marking serving', async () => {
    let complete: (() => void) | undefined;
    sfn.on(SendTaskSuccessCommand).callsFake(() => new Promise<void>(resolve => { complete = resolve; }));
    const pending = handler(event());
    await vi.waitFor(() => { expect(complete).toBeTypeOf('function'); });
    expect(db.markServing).not.toHaveBeenCalled();
    complete?.();
    await pending;
    expect(db.markServing).toHaveBeenCalledOnce();
  });

  it.each(['task', 'write', 'load', 'broadcast'])('propagates other %s errors', async source => {
    const error = new Error('Unavailable');
    if (source === 'task') sfn.on(SendTaskSuccessCommand).rejects(error);
    if (source === 'write') db.markServing.mockRejectedValue(error);
    if (source === 'load') db.loadOffice.mockRejectedValue(error);
    if (source === 'broadcast') fanout.broadcast.mockRejectedValue(error);
    await expect(handler(event())).rejects.toBe(error);
    if (source !== 'broadcast') expect(fanout.broadcast).not.toHaveBeenCalled();
  });
});
