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
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('broadcaster', () => {
  it('acknowledges an empty batch without broadcasting', async () => {
    expect(await handler(event())).toEqual({ batchItemFailures: [] });
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('coalesces all requests for each office and handles every office in the batch', async () => {
    expect(await handler(event(record('clinic'), record('licensing'), record('clinic'))))
      .toEqual({ batchItemFailures: [] });
    expect(broadcast).toHaveBeenCalledTimes(2);
    expect(broadcast).toHaveBeenCalledWith('clinic', rules, expect.any(Object));
    expect(broadcast).toHaveBeenCalledWith('licensing', rules, expect.any(Object));
  });

  it('retries a failed read after 100 ms and 400 ms then acknowledges every office', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const error = new Error('read failed');
    vi.mocked(broadcast).mockImplementation(async officeId => {
      if (officeId === 'clinic') throw error;
    });
    const pending = handler(event(record('clinic'), record('licensing'), record('clinic'), record('permits')));
    await vi.advanceTimersByTimeAsync(0);
    expect(broadcast).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(99);
    expect(broadcast).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(broadcast).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(399);
    expect(broadcast).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ batchItemFailures: [] });
    expect(broadcast).toHaveBeenCalledTimes(5);
    expect(console.error).toHaveBeenCalledWith(expect.any(String), 'clinic', error);
    expect(console.info).toHaveBeenCalledWith(expect.objectContaining({ officeId: 'clinic', attempts: 3 }));
  });

  it.each([1, 2])('stops retrying when the read succeeds after %i failures', async failures => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    for (let i = 0; i < failures; i++) vi.mocked(broadcast).mockRejectedValueOnce(new Error('read failed'));
    const pending = handler(event(record('clinic')));
    await vi.runAllTimersAsync();
    expect(await pending).toEqual({ batchItemFailures: [] });
    expect(broadcast).toHaveBeenCalledTimes(failures + 1);
    expect(console.error).not.toHaveBeenCalled();
    expect(console.info).toHaveBeenCalledWith(expect.objectContaining({ attempts: failures + 1 }));
  });

  it('acknowledges a completed broadcast without retrying delivery failures', async () => {
    expect(await handler(event(record('clinic')))).toEqual({ batchItemFailures: [] });
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(console.info).toHaveBeenCalledWith(expect.objectContaining({ attempts: 1 }));
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
    expect(broadcast).toHaveBeenCalledExactlyOnceWith('licensing', rules, expect.any(Object));
    expect(console.error).toHaveBeenCalledWith(expect.any(String), bad.messageId, expect.anything());
  });

  it('logs cumulative read and send timings across attempts without adding retry delays to queue latency', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.mocked(broadcast).mockImplementationOnce(async (_officeId, _rules, metrics) => {
      if (metrics) metrics.readMs += 15;
      throw new Error('read failed');
    }).mockImplementationOnce(async (_officeId, _rules, metrics) => {
      if (metrics) {
        metrics.readMs += 12;
        metrics.sendMs += 20;
        metrics.connections += 2;
      }
      vi.mocked(Date.now).mockReturnValue(now + 147);
    });
    const pending = handler(event(record('clinic')));
    await vi.runAllTimersAsync();
    await pending;
    expect(console.info).toHaveBeenCalledExactlyOnceWith({
      event: 'broadcast_queue_latency', officeId: 'clinic', requestedAt: now - 100,
      queueLatencyMs: 100, requestCount: 1, readMs: 27, sendMs: 20, connections: 2, attempts: 2,
    });
  });

  it('logs the oldest request latency for each coalesced office', async () => {
    await handler(event(record('clinic', now - 20), record('clinic', now - 120)));
    expect(console.info).toHaveBeenCalledWith({
      event: 'broadcast_queue_latency', officeId: 'clinic', requestedAt: now - 120,
      queueLatencyMs: 120, requestCount: 2, readMs: 0, sendMs: 0, connections: 0, attempts: 1,
    });
  });
});
