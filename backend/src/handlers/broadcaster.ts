import type { SQSBatchResponse, SQSEvent } from 'aws-lambda';
import { broadcast } from '../lib/broadcast';
import type { BroadcastMetrics, BroadcastRequest } from '../lib/broadcast';
import { rules } from '../lib/config';

function parseRequest(body: string): BroadcastRequest {
  const value: unknown = JSON.parse(body);
  if (typeof value !== 'object' || value === null ||
    !('officeId' in value) || typeof value.officeId !== 'string' || !value.officeId.trim() ||
    !('requestedAt' in value) || typeof value.requestedAt !== 'number' ||
    !Number.isSafeInteger(value.requestedAt) || value.requestedAt < 0) {
    throw new Error('Invalid broadcast request');
  }
  return { officeId: value.officeId, requestedAt: value.requestedAt };
}

export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const offices = new Map<string, { messageIds: string[]; requestedAt: number }>();
  for (const record of event.Records) {
    try {
      const request = parseRequest(record.body);
      const group = offices.get(request.officeId);
      if (group) {
        group.messageIds.push(record.messageId);
        group.requestedAt = Math.min(group.requestedAt, request.requestedAt);
      } else {
        offices.set(request.officeId, { messageIds: [record.messageId], requestedAt: request.requestedAt });
      }
    } catch (error) {
      console.error('Malformed broadcast request', record.messageId, error);
    }
  }

  for (const [officeId, group] of offices) {
    const queueLatencyMs = Date.now() - group.requestedAt;
    const metrics: BroadcastMetrics = { readMs: 0, sendMs: 0, connections: 0 };
    let attempts = 0;
    for (const delayMs of [0, 100, 400]) {
      if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
      attempts++;
      try {
        await broadcast(officeId, rules(), metrics);
        break;
      } catch (error) {
        if (attempts === 3) console.error('Queued broadcast failed', officeId, error);
      }
    }
    console.info({
      event: 'broadcast_queue_latency', officeId, requestedAt: group.requestedAt,
      queueLatencyMs, requestCount: group.messageIds.length, ...metrics, attempts,
    });
  }
  return { batchItemFailures: [] };
}
