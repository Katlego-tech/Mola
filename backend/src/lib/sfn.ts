import { SFNClient, SendTaskFailureCommand, SendTaskSuccessCommand, StartExecutionCommand } from '@aws-sdk/client-sfn';

export interface CallInput {
  officeId: string;
  ticketNo: number;
  desk: string;
  confirmWindowSeconds: number;
}

export const sfn = new SFNClient({});

export async function startCall(input: CallInput, calledAtMs: number): Promise<void> {
  await sfn.send(new StartExecutionCommand({
    stateMachineArn: process.env.STATE_MACHINE_ARN,
    name: `${input.officeId}-${input.ticketNo}-${calledAtMs}`,
    input: JSON.stringify(input),
  }));
}

function isDead(error: unknown): boolean {
  return error instanceof Error &&
    ['TaskTimedOut', 'TaskDoesNotExist', 'InvalidToken'].includes(error.name);
}

export async function succeedTask(taskToken: string, output: Record<string, unknown>): Promise<'ok' | 'dead'> {
  try {
    await sfn.send(new SendTaskSuccessCommand({ taskToken, output: JSON.stringify(output) }));
    return 'ok';
  } catch (error) {
    if (isDead(error)) return 'dead';
    throw error;
  }
}

export async function failTask(taskToken: string, error: string, cause: string): Promise<'ok' | 'dead'> {
  try {
    await sfn.send(new SendTaskFailureCommand({ taskToken, error, cause }));
    return 'ok';
  } catch (error) {
    if (isDead(error)) return 'dead';
    throw error;
  }
}
