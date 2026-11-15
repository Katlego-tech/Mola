import { rules } from './config';
import { claimTicket, finishServing, loadOffice, revertClaim } from './db';
import { waitingLine } from './ordering';
import { startCall } from './sfn';

function isConditionalFailure(error: unknown): boolean {
  return error instanceof Error && error.name === 'ConditionalCheckFailedException';
}

export async function callNext(officeId: string, desk: string):
  Promise<{ called: number } | { empty: true } | { busy: true }> {
  const now = Date.now();
  const { tickets } = await loadOffice(officeId);
  if (tickets.some(ticket => ticket.status === 'called' && ticket.desk === desk)) {
    return { busy: true };
  }

  const nowIso = new Date(now).toISOString();
  for (const ticket of tickets) {
    if (ticket.status === 'serving' && ticket.desk === desk) {
      try {
        await finishServing(officeId, ticket.ticketNo, nowIso);
      } catch (error) {
        if (!isConditionalFailure(error)) throw error;
      }
    }
  }

  for (const ticket of waitingLine(tickets, now / 1000)) {
    try {
      await claimTicket(officeId, ticket.ticketNo, desk, nowIso);
    } catch (error) {
      if (isConditionalFailure(error)) continue;
      throw error;
    }
    try {
      await startCall({
        officeId, ticketNo: ticket.ticketNo, desk,
        confirmWindowSeconds: rules().confirmWindowSeconds,
      }, now);
    } catch (error) {
      try {
        await revertClaim(officeId, ticket.ticketNo);
      } catch (revertError) {
        if (!isConditionalFailure(revertError)) throw revertError;
      }
      throw error;
    }
    return { called: ticket.ticketNo };
  }
  return { empty: true };
}
