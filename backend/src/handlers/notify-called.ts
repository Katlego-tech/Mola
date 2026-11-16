import { requestBroadcast } from '../lib/broadcast';
import { storeTaskToken } from '../lib/db';
import type { CallInput } from '../lib/sfn';
import { failTask } from '../lib/sfn';

export interface NotifyCalledEvent extends CallInput {
  taskToken: string;
}

export async function handler(e: NotifyCalledEvent): Promise<void> {
  const { officeId, ticketNo, taskToken, confirmWindowSeconds, calledAt } = e;
  try {
    // Only for the call this execution belongs to (calledAt is the call's identity, call-flow.md 3).
    await storeTaskToken(officeId, ticketNo, taskToken, Date.now() + confirmWindowSeconds * 1000, calledAt);
  } catch (error) {
    if (!(error instanceof Error && error.name === 'ConditionalCheckFailedException')) throw error;
    await failTask(taskToken, 'Patron.Left', 'Ticket is no longer being called');
    return;
  }
  await requestBroadcast(officeId);
}
