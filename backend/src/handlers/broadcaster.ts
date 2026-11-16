import type { SQSBatchResponse, SQSEvent } from 'aws-lambda';
import { broadcast } from '../lib/broadcast';
import type { BroadcastRequest } from '../lib/broadcast';
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

  const batchItemFailures: SQSBatchResponse['batchItemFailures'] = [];
  for (const [officeId, group] of offices) {
    console.info({
      event: 'broadcast_queue_latency', officeId, requestedAt: group.requestedAt,
      queueLatencyMs: Date.now() - group.requestedAt, requestCount: group.messageIds.length,
    });
    try {
      await broadcast(officeId, rules());
    } catch (error) {
      console.error('Queued broadcast failed', officeId, error);
      batchItemFailures.push(...group.messageIds.map(itemIdentifier => ({ itemIdentifier })));
    }
  }
  return { batchItemFailures };
}
