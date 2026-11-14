import { deleteScreen, loadOffice, removeTicketConnection } from './db';
import type { Board, ServerMessage } from './messages';
import { positions, waitingLine } from './ordering';
import { boardOf, ticketView } from './views';
import { send } from './ws';

export async function broadcast(officeId: string, rules: Board['rules']): Promise<void> {
  try {
    const snapshot = await loadOffice(officeId);
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
        payload: { type: 'board', board },
        remove: () => deleteScreen(officeId, screen.connectionId),
      });
    }

    for (let offset = 0; offset < deliveries.length; offset += 25) {
      const batch = deliveries.slice(offset, offset + 25);
      const results = await Promise.allSettled(batch.map(async delivery => {
        if (await send(delivery.connectionId, delivery.payload) === 'gone') {
          await delivery.remove();
        }
      }));
      for (const [index, result] of results.entries()) {
        if (result.status === 'rejected') {
          console.error('Broadcast delivery failed', batch[index]?.connectionId, result.reason);
        }
      }
    }
  } catch (error) {
    console.error('Broadcast failed', officeId, error);
  }
}
