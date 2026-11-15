import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  putConnection: vi.fn(), getConnection: vi.fn(), deleteConnection: vi.fn(),
  deleteScreen: vi.fn(), removeTicketConnection: vi.fn(),
}));
vi.mock('../src/lib/db', () => db);

const { handler } = await import('../src/handlers/connection');

const event = (routeKey: string, query?: Record<string, string>) => ({
  requestContext: { routeKey, connectionId: 'c-1' },
  queryStringParameters: query,
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers({ now: new Date('2027-03-01T08:00:00Z') });
});

describe('$connect', () => {
  it('stores the connection with its office, role and a 2-hour expiry', async () => {
    const res = await handler(event('$connect', { office: 'soweto-clinic', role: 'screen' }));
    expect(res).toEqual({ statusCode: 200 });
    expect(db.putConnection).toHaveBeenCalledWith({
      connectionId: 'c-1', officeId: 'soweto-clinic', role: 'screen',
      expiresAt: Date.parse('2027-03-01T08:00:00Z') / 1000 + 7200,
    });
  });

  it('defaults the role to patron', async () => {
    await handler(event('$connect', { office: 'demo' }));
    expect(db.putConnection).toHaveBeenCalledWith(expect.objectContaining({ role: 'patron' }));
  });

  it.each([
    [{ office: 'Bad Office!' }],
    [{ office: '' }],
    [{ office: 'a'.repeat(41) }],
    [{ office: 'demo', role: 'admin' }],
    [undefined],
  ])('refuses %j with 400 and stores nothing', async (query) => {
    const res = await handler(event('$connect', query));
    expect(res).toEqual({ statusCode: 400, body: 'Invalid office or role' });
    expect(db.putConnection).not.toHaveBeenCalled();
  });
});

describe('$disconnect', () => {
  it('removes the connection, its screen entry and its hold on a ticket', async () => {
    db.getConnection.mockResolvedValue({ connectionId: 'c-1', officeId: 'demo', role: 'screen', ticketNo: 42, expiresAt: 1 });
    expect(await handler(event('$disconnect'))).toEqual({ statusCode: 200 });
    expect(db.deleteConnection).toHaveBeenCalledWith('c-1');
    expect(db.deleteScreen).toHaveBeenCalledWith('demo', 'c-1');
    expect(db.removeTicketConnection).toHaveBeenCalledWith('demo', 42, 'c-1');
  });

  it('leaves the screen list alone for a patron without a ticket', async () => {
    db.getConnection.mockResolvedValue({ connectionId: 'c-1', officeId: 'demo', role: 'patron', expiresAt: 1 });
    await handler(event('$disconnect'));
    expect(db.deleteScreen).not.toHaveBeenCalled();
    expect(db.removeTicketConnection).not.toHaveBeenCalled();
  });

  it('still answers 200 when the ticket already moved to another connection', async () => {
    db.getConnection.mockResolvedValue({ connectionId: 'c-1', officeId: 'demo', role: 'patron', ticketNo: 42, expiresAt: 1 });
    db.removeTicketConnection.mockRejectedValue(Object.assign(new Error('cond'), { name: 'ConditionalCheckFailedException' }));
    expect(await handler(event('$disconnect'))).toEqual({ statusCode: 200 });
  });

  it('still deletes the connection when reading it fails', async () => {
    db.getConnection.mockRejectedValue(Object.assign(new Error('slow down'), { name: 'ProvisionedThroughputExceededException' }));
    expect(await handler(event('$disconnect'))).toEqual({ statusCode: 200 });
    expect(db.deleteConnection).toHaveBeenCalledWith('c-1');
  });

  it('answers 200 for a connection that was never stored', async () => {
    db.getConnection.mockResolvedValue(null);
    expect(await handler(event('$disconnect'))).toEqual({ statusCode: 200 });
    expect(db.deleteConnection).toHaveBeenCalledWith('c-1');
  });
});
