import { broadcast } from '../lib/broadcast';
import { rules } from '../lib/config';
import { storeTaskToken } from '../lib/db';
import type { CallInput } from '../lib/sfn';
import { failTask } from '../lib/sfn';

export interface NotifyCalledEvent extends CallInput {
  taskToken: string;
}

export async function handler(e: NotifyCalledEvent): Promise<void> {
  const { officeId, ticketNo, taskToken, confirmWindowSeconds } = e;
  try {
    await storeTaskToken(officeId, ticketNo, taskToken, Date.now() + confirmWindowSeconds * 1000);
  } catch (error) {
    if (!(error instanceof Error && error.name === 'ConditionalCheckFailedException')) throw error;
    await failTask(taskToken, 'Patron.Left', 'Ticket is no longer being called');
    return;
  }
  await broadcast(officeId, rules());
}
