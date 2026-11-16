import { randomBytes } from 'node:crypto';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { rules as currentRules } from './config';
import { deleteScreen, loadOffice, removeTicketConnection } from './db';
import type { Board, ServerMessage } from './messages';
import { positions, waitingLine } from './ordering';
import { boardOf, screenBoard, ticketView } from './views';
import { send } from './ws';

export interface BroadcastRequest {
  officeId: string;
  requestedAt: number;
}

export interface BroadcastMetrics {
  readMs: number;
  sendMs: number;
  connections: number;
}

const sqs = new SQSClient({});

/** Enqueue a refresh for the office; on any SendMessage error, broadcast directly instead. */
export async function requestBroadcast(officeId: string): Promise<void> {
  try {
    const queueUrl = process.env.BROADCAST_QUEUE_URL;
    if (!queueUrl) throw new Error('BROADCAST_QUEUE_URL is not set');
    const requestedAt = Date.now();
    const request: BroadcastRequest = { officeId, requestedAt };
    await sqs.send(new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(request),
      MessageGroupId: officeId,
      MessageDeduplicationId: `${officeId}:${requestedAt}:${randomBytes(4).toString('hex')}`,
    }));
  } catch (error) {
    console.error('Broadcast enqueue failed', officeId, error);
    try {
      await broadcast(officeId, currentRules());
    } catch (fallbackError) {
      console.error('Broadcast fallback failed', officeId, fallbackError);
    }
  }
}

export async function broadcast(
  officeId: string, rules: Board['rules'],
  metrics: BroadcastMetrics = { readMs: 0, sendMs: 0, connections: 0 },
): Promise<void> {
  const readStartedAt = Date.now();
  const snapshot = await loadOffice(officeId).catch((error: unknown) => {
    console.error('Broadcast failed', officeId, error);
    throw error;
  }).finally(() => { metrics.readMs += Date.now() - readStartedAt; });
  const nowMs = Date.now();
  const board = boardOf(officeId, snapshot, nowMs, rules);
  const positionMap = positions(waitingLine(snapshot.tickets, nowMs / 1000));
  const deliveries: { connectionId: string; payload: ServerMessage; remove: () => Promise<void> }[] = [];

  for (const ticket of snapshot.tickets) {
    const connectionId = ticket.connectionId;
    if (connectionId !== undefined && ticket.expiresAt > nowMs / 1000) {
      deliveries.push({
        connectionId,
        payload: { type: 'status', ticket: ticketView(ticket, positionMap), board },
        remove: () => removeTicketConnection(officeId, ticket.ticketNo, connectionId),
      });
    }
  }
  for (const screen of snapshot.screens) {
    deliveries.push({
      connectionId: screen.connectionId,
      payload: screenBoard(officeId, snapshot, nowMs, rules, screen.trusted),
      remove: () => deleteScreen(officeId, screen.connectionId),
    });
  }

  metrics.connections += deliveries.length;
  const sendStartedAt = Date.now();
  for (let offset = 0; offset < deliveries.length; offset += 25) {
    const batch = deliveries.slice(offset, offset + 25);
    const results = await Promise.allSettled(batch.map(async delivery => {
      if (await send(delivery.connectionId, delivery.payload) === 'gone') {
        await delivery.remove();
      }
    }));
    for (const [index, result] of results.entries()) {
      if (result.status === 'rejected') {
        console.error('Broadcast delivery failed', batch[index]?.connectionId,
          result.reason instanceof Error ? result.reason.name : 'UnknownError');
      }
    }
  }
  metrics.sendMs += Date.now() - sendStartedAt;
}
