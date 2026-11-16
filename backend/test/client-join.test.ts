import { createHash, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Connection, OfficeSnapshot, Ticket, TicketStatus } from '../src/lib/model';
import type { ServerMessage } from '../src/lib/messages';

const staffKey = randomUUID();
const code = randomUUID().replaceAll('-', '').slice(0, 16);
const db = vi.hoisted(() => ({
  getConnection: vi.fn<(id: string) => Promise<Connection | null>>(),
  loadOffice: vi.fn<(officeId: string) => Promise<OfficeSnapshot>>(),
  consumeJoinCode: vi.fn(),
  nextTicketNo: vi.fn<(officeId: string, nowIso: string) => Promise<number>>(),
  putTicket: vi.fn<(ticket: Ticket) => Promise<void>>(),
  setConnectionTicket: vi.fn<(id: string, ticketNo: number) => Promise<void>>(),
  bindTicketConnection: vi.fn<(officeId: string, ticketNo: number, id: string) => Promise<void>>(),
  markLeft: vi.fn<(officeId: string, ticketNo: number, from: 'waiting' | 'called', closedAtIso: string) => Promise<void>>(),
}));
const ws = vi.hoisted(() => ({ send: vi.fn<(id: string, message: ServerMessage) => Promise<'sent' | 'gone'>>() }));
const fanout = vi.hoisted(() => ({ requestBroadcast: vi.fn() }));
vi.mock('../src/lib/db', () => db);
vi.mock('../src/lib/ws', () => ws);
vi.mock('../src/lib/broadcast', () => fanout);

const { handler } = await import('../src/handlers/client');
const now = Date.parse('2027-03-01T08:00:00.123Z');
const officeRules = { confirmWindowSeconds: 120, dropBackPlaces: 3, maxMisses: 2 };
const event = (action: 'join' | 'resume', connectionId = 'c-9', secret?: string) => ({
  requestContext: { routeKey: action, connectionId },
  body: JSON.stringify(action === 'join' ? { action, staffKey } : { action, ticketNo: 42, secret }),
});
const connection = (overrides: Partial<Connection> = {}): Connection => ({
  connectionId: 'c-9', officeId: 'demo', role: 'patron', expiresAt: Math.floor(now / 1000) + 7200,
  ...overrides,
});
const ticket = (overrides: Partial<Ticket> = {}): Ticket => ({
  officeId: 'demo', ticketNo: 42, status: 'waiting', queueKey: 42,
  secretHash: createHash('sha256').update(randomUUID()).digest('hex'),
  connectionId: 'old-phone', misses: 0, createdAt: new Date(now).toISOString(),
  expiresAt: Math.floor(now / 1000) + 43200, ...overrides,
});
const snapshot = (tickets: Ticket[] = []): OfficeSnapshot => ({ readAt: 1000, office: null, tickets, screens: [] });
const expectNoWrites = () => {
  expect(db.nextTicketNo).not.toHaveBeenCalled();
  expect(db.putTicket).not.toHaveBeenCalled();
  expect(db.setConnectionTicket).not.toHaveBeenCalled();
  expect(db.bindTicketConnection).not.toHaveBeenCalled();
  expect(db.markLeft).not.toHaveBeenCalled();
  expect(fanout.requestBroadcast).not.toHaveBeenCalled();
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers({ now });
  vi.stubEnv('CONFIRM_WINDOW_SECONDS', '120');
  vi.stubEnv('DROP_BACK_PLACES', '3');
  vi.stubEnv('MAX_MISSES', '2');
  vi.stubEnv('TICKET_LIFETIME_HOURS', '12');
  db.getConnection.mockResolvedValue(connection());
  db.loadOffice.mockResolvedValue(snapshot());
  db.nextTicketNo.mockResolvedValue(42);
  vi.stubEnv('STAFF_KEY_SHA256', createHash('sha256').update(staffKey).digest('hex'));
  db.consumeJoinCode.mockResolvedValue(42);
  ws.send.mockResolvedValue('sent');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('join', () => {
  it('stores a waiting ticket with a hashed secret, binds it, sends the secret once, then requests a refresh', async () => {
    expect(await handler(event('join'))).toEqual({ statusCode: 200 });
    const message = ws.send.mock.calls[0]?.[1];
    expect(message?.type).toBe('ticket');
    if (message?.type !== 'ticket') throw new Error('Expected a ticket message');
    expect(message).toEqual({ type: 'ticket', officeId: 'demo', ticketNo: 42, secret: expect.any(String) });
    expect(message.secret).toMatch(/^[0-9a-f-]{36}$/);
    expect(db.nextTicketNo).toHaveBeenCalledExactlyOnceWith('demo', new Date(now).toISOString());
    expect(db.putTicket).toHaveBeenCalledExactlyOnceWith({
      officeId: 'demo', ticketNo: 42, status: 'waiting', queueKey: 42,
      secretHash: createHash('sha256').update(message.secret).digest('hex'),
      connectionId: 'c-9', misses: 0, createdAt: new Date(now).toISOString(),
      expiresAt: Math.floor(now / 1000) + 43200,
    });
    expect(db.setConnectionTicket).toHaveBeenCalledExactlyOnceWith('c-9', 42);
    expect(ws.send).toHaveBeenCalledExactlyOnceWith('c-9', message);
    expect(fanout.requestBroadcast).toHaveBeenCalledExactlyOnceWith('demo');
    expect(db.nextTicketNo).toHaveBeenCalledBefore(db.putTicket);
    expect(db.putTicket).toHaveBeenCalledBefore(db.setConnectionTicket);
    expect(db.setConnectionTicket).toHaveBeenCalledBefore(ws.send);
    expect(ws.send).toHaveBeenCalledBefore(fanout.requestBroadcast);
    expect(db.markLeft).not.toHaveBeenCalled();
  });

  it('closes the waiting ticket when its secret delivery returns gone, then requests a refresh', async () => {
    ws.send.mockResolvedValue('gone');
    expect(await handler(event('join'))).toEqual({ statusCode: 200 });
    expect(db.markLeft).toHaveBeenCalledExactlyOnceWith('demo', 42, 'waiting', new Date(now).toISOString());
    expect(fanout.requestBroadcast).toHaveBeenCalledExactlyOnceWith('demo');
    expect(ws.send).toHaveBeenCalledBefore(db.markLeft);
    expect(db.markLeft).toHaveBeenCalledBefore(fanout.requestBroadcast);
  });

  it('requests a refresh before rethrowing a secret delivery error', async () => {
    const error = new Error('Delivery failed');
    ws.send.mockRejectedValue(error);
    await expect(handler(event('join'))).rejects.toBe(error);
    expect(fanout.requestBroadcast).toHaveBeenCalledExactlyOnceWith('demo');
    expect(ws.send).toHaveBeenCalledBefore(fanout.requestBroadcast);
    expect(db.markLeft).not.toHaveBeenCalled();
  });

  it('ignores a conditional failure closing an undelivered ticket and still requests a refresh', async () => {
    ws.send.mockResolvedValue('gone');
    db.markLeft.mockRejectedValue(Object.assign(new Error('Ticket already changed'), { name: 'ConditionalCheckFailedException' }));
    expect(await handler(event('join'))).toEqual({ statusCode: 200 });
    expect(db.markLeft).toHaveBeenCalledExactlyOnceWith('demo', 42, 'waiting', new Date(now).toISOString());
    expect(fanout.requestBroadcast).toHaveBeenCalledExactlyOnceWith('demo');
    expect(db.markLeft).toHaveBeenCalledBefore(fanout.requestBroadcast);
  });

  it('propagates other closing failures after requesting a refresh', async () => {
    const error = new Error('Write failed');
    ws.send.mockResolvedValue('gone');
    db.markLeft.mockRejectedValue(error);
    await expect(handler(event('join'))).rejects.toBe(error);
    expect(fanout.requestBroadcast).toHaveBeenCalledExactlyOnceWith('demo');
    expect(db.markLeft).toHaveBeenCalledBefore(fanout.requestBroadcast);
  });

  it('gives concurrent joins on separate connections different counter numbers', async () => {
    let counter = 41;
    db.nextTicketNo.mockImplementation(() => Promise.resolve(++counter));
    await Promise.all([handler(event('join', 'phone-a')), handler(event('join', 'phone-b'))]);
    expect(db.putTicket.mock.calls.map(([t]) => t.ticketNo).sort()).toEqual([42, 43]);
    expect(db.setConnectionTicket).toHaveBeenCalledWith('phone-a', 42);
    expect(db.setConnectionTicket).toHaveBeenCalledWith('phone-b', 43);
    const secrets = ws.send.mock.calls.flatMap(([, message]) => message.type === 'ticket' ? [message.secret] : []);
    expect(new Set(secrets).size).toBe(2);
  });

  it('refuses screen connections without reading the office or writing', async () => {
    db.getConnection.mockResolvedValue(connection({ role: 'screen' }));
    await handler(event('join'));
    expect(ws.send).toHaveBeenCalledExactlyOnceWith('c-9', expect.objectContaining({ type: 'error', code: 'forbidden' }));
    expect(db.loadOffice).not.toHaveBeenCalled();
    expectNoWrites();
  });

  it.each<TicketStatus>(['waiting', 'called', 'serving'])('refuses a second join while the connection holds a %s ticket', async status => {
    await handler(event('join'));
    vi.clearAllMocks();
    db.getConnection.mockResolvedValue(connection({ ticketNo: 42 }));
    db.loadOffice.mockResolvedValue(snapshot([ticket({ status })]));
    await handler(event('join'));
    expect(db.loadOffice).toHaveBeenCalledExactlyOnceWith('demo');
    expect(ws.send).toHaveBeenCalledExactlyOnceWith('c-9', expect.objectContaining({ type: 'error', code: 'already_has_ticket' }));
    expectNoWrites();
  });

  it.each<TicketStatus>(['done', 'left', 'no_show'])('allows another join after the previous ticket is %s', async status => {
    db.getConnection.mockResolvedValue(connection({ ticketNo: 41 }));
    db.loadOffice.mockResolvedValue(snapshot([ticket({ ticketNo: 41, status })]));
    await handler(event('join'));
    expect(db.putTicket).toHaveBeenCalledOnce();
    expect(fanout.requestBroadcast).toHaveBeenCalledOnce();
  });

  it('allows a join when the prior ticket is absent from the live snapshot', async () => {
    db.getConnection.mockResolvedValue(connection({ ticketNo: 41 }));
    db.loadOffice.mockResolvedValue(snapshot([ticket({ ticketNo: 99 })]));
    await handler(event('join'));
    expect(db.putTicket).toHaveBeenCalledOnce();
  });
});

describe('resume', () => {
  it.each<TicketStatus>(['waiting', 'called', 'serving', 'done', 'left', 'no_show'])('rebinds a %s ticket and sends only this connection its status and board', async status => {
    const secret = randomUUID();
    const t = ticket({ status, secretHash: createHash('sha256').update(secret).digest('hex'), desk: 'Desk 2' });
    db.loadOffice.mockResolvedValue(snapshot([t, ticket({ ticketNo: 41, queueKey: 41 })]));
    expect(await handler(event('resume', 'c-9', secret))).toEqual({ statusCode: 200 });
    expect(db.loadOffice).toHaveBeenCalledExactlyOnceWith('demo');
    expect(db.bindTicketConnection).toHaveBeenCalledExactlyOnceWith('demo', 42, 'c-9');
    expect(db.setConnectionTicket).toHaveBeenCalledExactlyOnceWith('c-9', 42);
    expect(ws.send).toHaveBeenCalledExactlyOnceWith('c-9', {
      type: 'status',
      ticket: { ticketNo: 42, status, position: status === 'waiting' ? 2 : null,
        desk: status === 'called' || status === 'serving' ? 'Desk 2' : null, deadline: null, misses: 0 },
      board: { officeId: 'demo', notesVersion: 0,
        calling: status === 'called' ? [{ ticketNo: 42, desk: 'Desk 2', deadline: null }] : [],
        serving: status === 'serving' ? [{ ticketNo: 42, desk: 'Desk 2' }] : [],
        waitingCount: status === 'waiting' ? 2 : 1, upNext: status === 'waiting' ? [41, 42] : [41],
        snapshotAt: 1000, serverTime: now, rules: officeRules },
    });
    expect(db.bindTicketConnection).toHaveBeenCalledBefore(db.setConnectionTicket);
    expect(db.setConnectionTicket).toHaveBeenCalledBefore(ws.send);
    expect(db.nextTicketNo).not.toHaveBeenCalled();
    expect(db.putTicket).not.toHaveBeenCalled();
    expect(fanout.requestBroadcast).not.toHaveBeenCalled();
  });

  it('refuses a wrong secret without writing', async () => {
    db.loadOffice.mockResolvedValue(snapshot([ticket()]));
    await handler(event('resume', 'c-9', randomUUID()));
    expect(ws.send).toHaveBeenCalledExactlyOnceWith('c-9', expect.objectContaining({ type: 'error', code: 'bad_ticket' }));
    expectNoWrites();
  });

  it('uses queue order for the resumed ticket position', async () => {
    const secret = randomUUID();
    db.loadOffice.mockResolvedValue(snapshot([
      ticket({ ticketNo: 40, queueKey: 3 }),
      ticket({ ticketNo: 41, queueKey: 1 }),
      ticket({ ticketNo: 42, queueKey: 2, secretHash: createHash('sha256').update(secret).digest('hex') }),
    ]));
    await handler(event('resume', 'c-9', secret));
    expect(ws.send).toHaveBeenCalledExactlyOnceWith('c-9', expect.objectContaining({
      type: 'status',
      ticket: expect.objectContaining({ ticketNo: 42, position: 2 }),
      board: expect.objectContaining({ waitingCount: 3, upNext: [41, 42, 40] }),
    }));
    expect(fanout.requestBroadcast).not.toHaveBeenCalled();
  });

  it('refuses a missing ticket without writing', async () => {
    const secret = randomUUID();
    db.loadOffice.mockResolvedValue(snapshot());
    await handler(event('resume', 'c-9', secret));
    expect(ws.send).toHaveBeenCalledExactlyOnceWith('c-9', expect.objectContaining({ type: 'error', code: 'bad_ticket' }));
    expectNoWrites();
  });
});

describe('single-use codes', () => {
  const coded = () => ({ requestContext: { routeKey: 'join', connectionId: 'c-9' }, body: JSON.stringify({ action: 'join', code }) });
  it('consumes and rotates the code before issuing a ticket', async () => {
    await handler(coded());
    expect(db.consumeJoinCode).toHaveBeenCalledWith('demo', code, expect.stringMatching(/^[A-Za-z0-9_-]{16}$/), now, 120_000);
    expect(db.consumeJoinCode).toHaveBeenCalledBefore(db.putTicket);
    expect(db.nextTicketNo).not.toHaveBeenCalled();
    expect(db.putTicket).toHaveBeenCalledOnce();
  });
  it.each(['spent', 'expired'])('refuses a %s code without issuing a ticket', async () => {
    db.consumeJoinCode.mockRejectedValue(Object.assign(new Error('Unavailable'), { name: 'ConditionalCheckFailedException' }));
    await handler(coded());
    expect(ws.send).toHaveBeenCalledWith('c-9', expect.objectContaining({ type: 'error', code: 'stale_code' }));
    expect(db.putTicket).not.toHaveBeenCalled();
  });
  it('refuses an invalid staff key', async () => {
    vi.stubEnv('STAFF_KEY_SHA256', createHash('sha256').update(randomUUID()).digest('hex'));
    await handler(event('join'));
    expect(ws.send).toHaveBeenCalledWith('c-9', expect.objectContaining({ code: 'forbidden' }));
    expectNoWrites();
  });
});

it('issues once and rejects reuse of the consumed code', async () => {
  db.consumeJoinCode.mockResolvedValueOnce(42).mockRejectedValueOnce(Object.assign(new Error('Consumed'), { name: 'ConditionalCheckFailedException' }));
  const body = JSON.stringify({ action: 'join', code });
  await handler({ requestContext: { routeKey: 'join', connectionId: 'first-phone' }, body });
  await handler({ requestContext: { routeKey: 'join', connectionId: 'second-phone' }, body });
  expect(db.putTicket).toHaveBeenCalledOnce();
  expect(ws.send).toHaveBeenCalledWith('first-phone', expect.objectContaining({ type: 'ticket' }));
  expect(ws.send).toHaveBeenCalledWith('second-phone', expect.objectContaining({ type: 'error', code: 'stale_code' }));
});
