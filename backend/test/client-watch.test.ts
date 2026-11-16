import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ getConnection: vi.fn(), putScreen: vi.fn(), loadOffice: vi.fn() }));
const ws = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('../src/lib/db', () => db);
vi.mock('../src/lib/ws', () => ws);

const { handler } = await import('../src/handlers/client');

const event = (routeKey: string, body?: string) => ({ requestContext: { routeKey, connectionId: 'c-9' }, body });
const empty = { office: null, tickets: [], screens: [] };

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers({ now: new Date('2027-03-01T08:00:00Z') });
  process.env.CONFIRM_WINDOW_SECONDS = '120';
  process.env.DROP_BACK_PLACES = '3';
  process.env.MAX_MISSES = '2';
  ws.send.mockResolvedValue('sent');
});

describe('watch', () => {
  it('registers the screen and sends it the current board', async () => {
    db.getConnection.mockResolvedValue({ connectionId: 'c-9', officeId: 'demo', role: 'screen', expiresAt: 5 });
    db.loadOffice.mockResolvedValue(empty);
    expect(await handler(event('watch', '{"action":"watch"}'))).toEqual({ statusCode: 200 });
    expect(db.putScreen).toHaveBeenCalledWith({ officeId: 'demo', connectionId: 'c-9', expiresAt: 5 });
    expect(ws.send).toHaveBeenCalledWith('c-9', {
      type: 'board',
      board: {
        officeId: 'demo', calling: [], serving: [], waitingCount: 0, upNext: [],
        serverTime: Date.parse('2027-03-01T08:00:00Z'),
        rules: { confirmWindowSeconds: 120, dropBackPlaces: 3, maxMisses: 2 },
      },
    });
  });

  it('refuses a patron connection', async () => {
    db.getConnection.mockResolvedValue({ connectionId: 'c-9', officeId: 'demo', role: 'patron', expiresAt: 5 });
    await handler(event('watch', '{"action":"watch"}'));
    expect(db.putScreen).not.toHaveBeenCalled();
    expect(ws.send).toHaveBeenCalledWith('c-9', expect.objectContaining({ type: 'error', code: 'forbidden' }));
  });
});

describe('ping', () => {
  it('answers without reading or sending anything', async () => {
    expect(await handler(event('ping', '{"action":"ping"}'))).toEqual({ statusCode: 200 });
    expect(db.getConnection).not.toHaveBeenCalled();
    expect(ws.send).not.toHaveBeenCalled();
  });
});

describe('ping on $default', () => {
  it('answers without sending anything', async () => {
    db.getConnection.mockResolvedValue({ connectionId: 'c-9', officeId: 'demo', role: 'patron', expiresAt: 5 });
    expect(await handler(event('$default', '{"action":"ping"}'))).toEqual({ statusCode: 200 });
    expect(ws.send).not.toHaveBeenCalled();
  });
});

describe('refusals', () => {
  it('answers a malformed body with bad_request', async () => {
    await handler(event('$default', 'not json'));
    expect(ws.send).toHaveBeenCalledWith('c-9', expect.objectContaining({ type: 'error', code: 'bad_request' }));
  });

  it('answers an action the parser does not know with unknown_action', async () => {
    await handler(event('$default', '{"action":"dance"}'));
    expect(ws.send).toHaveBeenCalledWith('c-9', expect.objectContaining({ type: 'error', code: 'unknown_action' }));
    expect(db.getConnection).not.toHaveBeenCalled();
  });

  it('answers callNext, which belongs to the staff function, with unknown_action', async () => {
    db.getConnection.mockResolvedValue({ connectionId: 'c-9', officeId: 'demo', role: 'patron', expiresAt: 5 });
    await handler(event('$default', JSON.stringify({ action: 'callNext', desk: 'Desk 2', staffKey: crypto.randomUUID() })));
    expect(ws.send).toHaveBeenCalledWith('c-9', expect.objectContaining({ type: 'error', code: 'unknown_action' }));
  });

  it('answers a connection with no session with no_session', async () => {
    db.getConnection.mockResolvedValue(null);
    await handler(event('watch', '{"action":"watch"}'));
    expect(ws.send).toHaveBeenCalledWith('c-9', expect.objectContaining({ type: 'error', code: 'no_session' }));
  });
});
