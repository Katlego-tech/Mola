import { randomUUID } from 'node:crypto';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { SFNClient, SendTaskFailureCommand } from '@aws-sdk/client-sfn';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handler } from '../src/handlers/notify-called';
import type { NotifyCalledEvent } from '../src/handlers/notify-called';
import { broadcast } from '../src/lib/broadcast';
import { storeTaskToken } from '../src/lib/db';

vi.mock('../src/lib/db', () => ({ storeTaskToken: vi.fn() }));
vi.mock('../src/lib/broadcast', () => ({ broadcast: vi.fn() }));

const sdk = mockClient(SFNClient);
const now = 1_800_000_000_500;
let event: NotifyCalledEvent;

beforeEach(() => {
  vi.resetAllMocks();
  sdk.reset();
  sdk.on(SendTaskFailureCommand).resolves({});
  vi.spyOn(Date, 'now').mockReturnValue(now);
  vi.stubEnv('CONFIRM_WINDOW_SECONDS', '120');
  vi.stubEnv('DROP_BACK_PLACES', '3');
  vi.stubEnv('MAX_MISSES', '2');
  event = { officeId: 'demo', ticketNo: 42, desk: 'Desk 1', confirmWindowSeconds: 30, calledAt: '2027-01-01T08:00:00.000Z', taskToken: randomUUID() };
  vi.mocked(storeTaskToken).mockResolvedValue(undefined);
  vi.mocked(broadcast).mockResolvedValue(undefined);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

function lostRace(): ConditionalCheckFailedException {
  return new ConditionalCheckFailedException({ message: 'ticket left', $metadata: {} });
}

describe('NotifyCalled', () => {
  it('stores the token and event-based deadline before broadcasting with current rules', async () => {
    vi.mocked(broadcast).mockImplementation(() => {
      expect(storeTaskToken).toHaveBeenCalledExactlyOnceWith('demo', 42, event.taskToken, now + 30_000, event.calledAt);
      return Promise.resolve();
    });
    await expect(handler(event)).resolves.toBeUndefined();
    expect(broadcast).toHaveBeenCalledExactlyOnceWith('demo', {
      confirmWindowSeconds: 120, dropBackPlaces: 3, maxMisses: 2,
    });
    expect(sdk.calls()).toHaveLength(0);
  });

  it('sends SendTaskFailure with Patron.Left on a failed condition and does not broadcast', async () => {
    vi.mocked(storeTaskToken).mockRejectedValue(lostRace());
    await expect(handler(event)).resolves.toBeUndefined();
    expect(sdk.commandCalls(SendTaskFailureCommand)).toHaveLength(1);
    expect(sdk.commandCalls(SendTaskFailureCommand)[0]?.args[0].input).toEqual({
      taskToken: event.taskToken, error: 'Patron.Left', cause: 'Ticket is no longer being called',
    });
    expect(broadcast).not.toHaveBeenCalled();
  });

  it.each(['TaskTimedOut', 'TaskDoesNotExist', 'InvalidToken'])('returns without broadcasting when the callback is already closed (%s)', async name => {
    vi.mocked(storeTaskToken).mockRejectedValue(lostRace());
    sdk.on(SendTaskFailureCommand).rejects(Object.assign(new Error('closed'), { name }));
    await expect(handler(event)).resolves.toBeUndefined();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('throws other store errors unchanged for Step Functions to handle', async () => {
    const error = new Error('store failed');
    vi.mocked(storeTaskToken).mockRejectedValue(error);
    await expect(handler(event)).rejects.toBe(error);
    expect(sdk.calls()).toHaveLength(0);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('throws callback errors unchanged', async () => {
    const error = new Error('callback failed');
    vi.mocked(storeTaskToken).mockRejectedValue(lostRace());
    sdk.on(SendTaskFailureCommand).rejects(error);
    await expect(handler(event)).rejects.toBe(error);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('throws broadcast errors unchanged, including a conditional error', async () => {
    const error = lostRace();
    vi.mocked(broadcast).mockRejectedValue(error);
    await expect(handler(event)).rejects.toBe(error);
    expect(sdk.calls()).toHaveLength(0);
  });
});
