import { randomUUID } from 'node:crypto';
import type { SQSEvent, SQSRecord } from 'aws-lambda';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handler } from '../src/handlers/broadcaster';
import { broadcast } from '../src/lib/broadcast';

vi.mock('../src/lib/broadcast', () => ({ broadcast: vi.fn() }));

const now = 1_800_000_000_500;
const rules = { confirmWindowSeconds: 30, dropBackPlaces: 3, maxMisses: 2 };
function record(officeId: string, requestedAt = now - 100): SQSRecord {
  return {
    messageId: randomUUID(), receiptHandle: randomUUID(),
    body: JSON.stringify({ officeId, requestedAt }),
    attributes: {
      ApproximateReceiveCount: '1', SentTimestamp: String(requestedAt),
      SenderId: 'producer', ApproximateFirstReceiveTimestamp: String(now),
      MessageGroupId: officeId, MessageDeduplicationId: randomUUID(), SequenceNumber: '1',
    },
    messageAttributes: {}, md5OfBody: '', eventSource: 'aws:sqs',
    eventSourceARN: 'arn:aws:sqs:af-south-1:123456789012:broadcast.fifo', awsRegion: 'af-south-1',
  };
}
const event = (...Records: SQSRecord[]): SQSEvent => ({ Records });

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('CONFIRM_WINDOW_SECONDS', '30');
  vi.stubEnv('DROP_BACK_PLACES', '3');
  vi.stubEnv('MAX_MISSES', '2');
  vi.spyOn(Date, 'now').mockReturnValue(now);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.mocked(broadcast).mockResolvedValue(undefined);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('broadcaster', () => {
  it('acknowledges an empty batch without broadcasting', async () => {
    expect(await handler(event())).toEqual({ batchItemFailures: [] });
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('coalesces all requests for each office and handles every office in the batch', async () => {
    expect(await handler(event(record('clinic'), record('licensing'), record('clinic'))))
      .toEqual({ batchItemFailures: [] });
    expect(broadcast).toHaveBeenCalledTimes(2);
    expect(broadcast).toHaveBeenCalledWith('clinic', rules);
    expect(broadcast).toHaveBeenCalledWith('licensing', rules);
  });

  it('retries every coalesced message for a failed office while other offices succeed', async () => {
    const error = new Error('push failed');
    vi.mocked(broadcast).mockImplementation(async officeId => {
      if (officeId === 'clinic') throw error;
    });
    const first = record('clinic');
    const second = record('clinic');
    expect(await handler(event(first, record('licensing'), second, record('permits')))).toEqual({
      batchItemFailures: [{ itemIdentifier: first.messageId }, { itemIdentifier: second.messageId }],
    });
    expect(broadcast).toHaveBeenCalledTimes(3);
    expect(console.error).toHaveBeenCalledWith(expect.any(String), 'clinic', error);
  });

  it.each([
    'not json', 'null', '[]', '{}',
    JSON.stringify({ officeId: 1, requestedAt: now }),
    JSON.stringify({ officeId: '', requestedAt: now }),
    JSON.stringify({ officeId: 'clinic' }),
    JSON.stringify({ officeId: 'clinic', requestedAt: 'yesterday' }),
    JSON.stringify({ officeId: 'clinic', requestedAt: -1 }),
  ])('logs and drops a malformed body: %s', async body => {
    const bad = { ...record('clinic'), body };
    expect(await handler(event(bad, record('licensing')))).toEqual({ batchItemFailures: [] });
    expect(broadcast).toHaveBeenCalledExactlyOnceWith('licensing', rules);
    expect(console.error).toHaveBeenCalledWith(expect.any(String), bad.messageId, expect.anything());
  });

  it('logs the oldest request latency for each coalesced office', async () => {
    await handler(event(record('clinic', now - 20), record('clinic', now - 120)));
    expect(console.info).toHaveBeenCalledWith({
      event: 'broadcast_queue_latency', officeId: 'clinic', requestedAt: now - 120,
      queueLatencyMs: 120, requestCount: 2,
    });
  });
});
