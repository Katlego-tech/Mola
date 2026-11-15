import { createHash, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handler } from '../src/handlers/staff';
import { broadcast } from '../src/lib/broadcast';
import { callNext } from '../src/lib/calling';
import { getConnection } from '../src/lib/db';
import { send } from '../src/lib/ws';

vi.mock('../src/lib/db', () => ({ getConnection: vi.fn() }));
vi.mock('../src/lib/calling', () => ({ callNext: vi.fn() }));
vi.mock('../src/lib/broadcast', () => ({ broadcast: vi.fn() }));
vi.mock('../src/lib/ws', () => ({ send: vi.fn() }));

let staffKey: string;
const event = (body?: string | null) => ({ requestContext: { routeKey: 'callNext', connectionId: 'c-9' }, body });
const message = () => JSON.stringify({ action: 'callNext', desk: 'Desk 1', staffKey });
const screen = { connectionId: 'c-9', officeId: 'demo', role: 'screen', expiresAt: 5 } as const;
const configuredRules = { confirmWindowSeconds: 30, dropBackPlaces: 3, maxMisses: 2 };

beforeEach(() => {
  vi.resetAllMocks();
  staffKey = randomUUID();
  vi.stubEnv('STAFF_KEY_SHA256', createHash('sha256').update(staffKey).digest('hex'));
  vi.stubEnv('CONFIRM_WINDOW_SECONDS', '30');
  vi.stubEnv('DROP_BACK_PLACES', '3');
  vi.stubEnv('MAX_MISSES', '2');
  vi.mocked(getConnection).mockResolvedValue(screen);
  vi.mocked(callNext).mockResolvedValue({ called: 42 });
  vi.mocked(send).mockResolvedValue('sent');
  vi.mocked(broadcast).mockResolvedValue(undefined);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

async function expectError(body: string | null | undefined, code: string): Promise<void> {
  await expect(handler(event(body))).resolves.toEqual({ statusCode: 200 });
  expect(send).toHaveBeenCalledExactlyOnceWith('c-9', expect.objectContaining({ type: 'error', code }));
  expect(callNext).not.toHaveBeenCalled();
  expect(broadcast).not.toHaveBeenCalled();
}

describe('staff refusals', () => {
  it.each([undefined, null, 'not json'])('rejects malformed body %s before loading the session', async body => {
    await expectError(body, 'bad_request');
    expect(getConnection).not.toHaveBeenCalled();
  });

  it('preserves an unknown action parser error', async () => {
    await expectError(JSON.stringify({ action: 'dance' }), 'unknown_action');
    expect(getConnection).not.toHaveBeenCalled();
  });

  it('rejects an invalid desk before loading the session', async () => {
    await expectError(JSON.stringify({ action: 'callNext', desk: '_', staffKey }), 'bad_request');
    expect(getConnection).not.toHaveBeenCalled();
  });

  it.each(['callNext', 'watch'])('checks for a missing session before the %s action', async action => {
    vi.mocked(getConnection).mockResolvedValue(null);
    await expectError(action === 'callNext' ? message() : JSON.stringify({ action }), 'no_session');
  });

  it('rejects a different parsed action before checking the role', async () => {
    vi.mocked(getConnection).mockResolvedValue({ ...screen, role: 'patron' });
    await expectError(JSON.stringify({ action: 'watch' }), 'unknown_action');
  });

  it('rejects a patron even with the correct staff key', async () => {
    vi.mocked(getConnection).mockResolvedValue({ ...screen, role: 'patron' });
    await expectError(message(), 'forbidden');
  });

  it('rejects the wrong staff key (US3 scenario 4)', async () => {
    await expectError(JSON.stringify({ action: 'callNext', desk: 'Desk 1', staffKey: randomUUID() }), 'forbidden');
  });

  it('rejects a missing hash configuration', async () => {
    vi.stubEnv('STAFF_KEY_SHA256', undefined);
    await expectError(message(), 'forbidden');
  });

  it('rejects a plain key in place of the configured SHA-256 hash', async () => {
    vi.stubEnv('STAFF_KEY_SHA256', staffKey);
    await expectError(message(), 'forbidden');
  });
});

describe('staff callNext', () => {
  it('calls for the session office and requested desk, leaving notifications to NotifyCalled', async () => {
    await expect(handler(event(message()))).resolves.toEqual({ statusCode: 200 });
    expect(getConnection).toHaveBeenCalledExactlyOnceWith('c-9');
    expect(callNext).toHaveBeenCalledExactlyOnceWith('demo', 'Desk 1');
    expect(send).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('reports a busy desk without broadcasting', async () => {
    vi.mocked(callNext).mockResolvedValue({ busy: true });
    await expect(handler(event(message()))).resolves.toEqual({ statusCode: 200 });
    expect(send).toHaveBeenCalledExactlyOnceWith('c-9', expect.objectContaining({ type: 'error', code: 'desk_busy' }));
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('sends queue_empty before broadcasting with the current rules', async () => {
    vi.mocked(callNext).mockResolvedValue({ empty: true });
    vi.mocked(broadcast).mockImplementation(() => {
      expect(send).toHaveBeenCalledExactlyOnceWith('c-9', { type: 'notice', code: 'queue_empty' });
      return Promise.resolve();
    });
    await expect(handler(event(message()))).resolves.toEqual({ statusCode: 200 });
    expect(broadcast).toHaveBeenCalledExactlyOnceWith('demo', configuredRules);
  });

  it.each(['session', 'call', 'notice', 'broadcast'] as const)('logs a thrown %s error and replies internal', async stage => {
    const error = new Error(`${stage} failed`);
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    if (stage === 'session') vi.mocked(getConnection).mockRejectedValue(error);
    if (stage === 'call') vi.mocked(callNext).mockRejectedValue(error);
    if (stage === 'notice' || stage === 'broadcast') vi.mocked(callNext).mockResolvedValue({ empty: true });
    if (stage === 'notice') vi.mocked(send).mockRejectedValueOnce(error);
    if (stage === 'broadcast') vi.mocked(broadcast).mockRejectedValue(error);
    await expect(handler(event(message()))).resolves.toEqual({ statusCode: 200 });
    expect(log).toHaveBeenCalledWith(expect.any(String), error);
    expect(send).toHaveBeenLastCalledWith('c-9', expect.objectContaining({ type: 'error', code: 'internal' }));
  });
});
