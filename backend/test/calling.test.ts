import { randomUUID } from 'node:crypto';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { SFNClient, SendTaskFailureCommand, SendTaskSuccessCommand, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callNext } from '../src/lib/calling';
import { claimTicket, finishServing, loadOffice, revertClaim } from '../src/lib/db';
import type { Ticket } from '../src/lib/model';
import { failTask, sfn, startCall, succeedTask } from '../src/lib/sfn';

vi.mock('../src/lib/db', () => ({
  loadOffice: vi.fn(), claimTicket: vi.fn(), finishServing: vi.fn(), revertClaim: vi.fn(),
}));

const sdk = mockClient(SFNClient);
const now = 1_800_000_000_500;
const iso = new Date(now).toISOString();
const input = { officeId: 'demo', ticketNo: 42, desk: 'Desk 1', confirmWindowSeconds: 30, calledAt: iso };
function ticket(ticketNo: number, overrides: Partial<Ticket> = {}): Ticket {
  return {
    officeId: 'demo', ticketNo, status: 'waiting', queueKey: ticketNo,
    secretHash: randomUUID(), misses: 0, createdAt: iso, expiresAt: now / 1000 + 3600,
    ...overrides,
  };
}
function tickets(...items: Ticket[]): void {
  vi.mocked(loadOffice).mockResolvedValue({ readAt: 1000, office: null, tickets: items, screens: [] });
}
function lostRace(): ConditionalCheckFailedException {
  return new ConditionalCheckFailedException({ message: 'race lost', $metadata: {} });
}

beforeEach(() => {
  vi.resetAllMocks();
  sdk.reset();
  sdk.on(StartExecutionCommand).resolves({});
  sdk.on(SendTaskSuccessCommand).resolves({});
  sdk.on(SendTaskFailureCommand).resolves({});
  vi.spyOn(Date, 'now').mockReturnValue(now);
  vi.stubEnv('STATE_MACHINE_ARN', 'arn:aws:states:af-south-1:123456789012:stateMachine:called-ticket');
  vi.stubEnv('CONFIRM_WINDOW_SECONDS', '30');
  vi.stubEnv('DROP_BACK_PLACES', '3');
  vi.stubEnv('MAX_MISSES', '2');
  vi.mocked(claimTicket).mockResolvedValue(undefined);
  vi.mocked(finishServing).mockResolvedValue(undefined);
  vi.mocked(revertClaim).mockResolvedValue(undefined);
  tickets();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('callNext', () => {
  it('claims the first unexpired waiting ticket in queue order and starts its execution', async () => {
    tickets(ticket(1, { expiresAt: now / 1000 }), ticket(2), ticket(42, { queueKey: 0.5 }),
      ticket(3, { status: 'called', desk: 'Desk 2' }));
    sdk.on(StartExecutionCommand).callsFake(() => {
      expect(claimTicket).toHaveBeenCalledExactlyOnceWith('demo', 42, 'Desk 1', iso);
      return {};
    });
    await expect(callNext('demo', 'Desk 1')).resolves.toEqual({ called: 42 });
    expect(loadOffice).toHaveBeenCalledExactlyOnceWith('demo');
    expect(sdk.commandCalls(StartExecutionCommand)[0]?.args[0].input).toEqual({
      stateMachineArn: process.env.STATE_MACHINE_ARN, name: `demo-42-${now}`, input: JSON.stringify(input),
    });
    expect(revertClaim).not.toHaveBeenCalled();
  });

  it('skips a ticket whose claim loses a race with another desk', async () => {
    tickets(ticket(2), ticket(1));
    vi.mocked(claimTicket).mockRejectedValueOnce(lostRace());
    await expect(callNext('demo', 'Desk 1')).resolves.toEqual({ called: 2 });
    expect(vi.mocked(claimTicket).mock.calls).toEqual([
      ['demo', 1, 'Desk 1', iso], ['demo', 2, 'Desk 1', iso],
    ]);
    expect(sdk.commandCalls(StartExecutionCommand)).toHaveLength(1);
    expect(sdk.commandCalls(StartExecutionCommand)[0]?.args[0].input.input).toBe(
      JSON.stringify({ ...input, ticketNo: 2 }),
    );
  });

  it('returns busy and writes nothing when this desk has a called ticket', async () => {
    tickets(ticket(1), ticket(2, { status: 'serving', desk: 'Desk 1' }),
      ticket(3, { status: 'called', desk: 'Desk 1' }));
    await expect(callNext('demo', 'Desk 1')).resolves.toEqual({ busy: true });
    expect(finishServing).not.toHaveBeenCalled();
    expect(claimTicket).not.toHaveBeenCalled();
    expect(revertClaim).not.toHaveBeenCalled();
    expect(sdk.calls()).toHaveLength(0);
  });

  it('closes all serving tickets at this desk before claiming, ignoring a lost close race', async () => {
    tickets(ticket(1, { status: 'serving', desk: 'Desk 1' }),
      ticket(2, { status: 'serving', desk: 'Desk 1' }),
      ticket(3, { status: 'serving', desk: 'Desk 2' }), ticket(4));
    vi.mocked(finishServing).mockRejectedValueOnce(lostRace());
    vi.mocked(claimTicket).mockImplementation(() => {
      expect(vi.mocked(finishServing).mock.calls).toEqual([['demo', 1, iso], ['demo', 2, iso]]);
      return Promise.resolve();
    });
    await expect(callNext('demo', 'Desk 1')).resolves.toEqual({ called: 4 });
  });

  it('closes the serving ticket and returns empty with nobody waiting', async () => {
    tickets(ticket(1, { status: 'serving', desk: 'Desk 1' }));
    await expect(callNext('demo', 'Desk 1')).resolves.toEqual({ empty: true });
    expect(finishServing).toHaveBeenCalledExactlyOnceWith('demo', 1, iso);
    expect(claimTicket).not.toHaveBeenCalled();
    expect(sdk.calls()).toHaveLength(0);
  });

  it('returns empty for an empty office or when every claim loses a race', async () => {
    await expect(callNext('demo', 'Desk 1')).resolves.toEqual({ empty: true });
    tickets(ticket(1), ticket(2));
    vi.mocked(claimTicket).mockRejectedValue(lostRace());
    await expect(callNext('demo', 'Desk 1')).resolves.toEqual({ empty: true });
    expect(claimTicket).toHaveBeenCalledTimes(2);
    expect(sdk.calls()).toHaveLength(0);
  });

  it.each([false, true])('reverts a failed start and throws the start error (revert race: %s)', async race => {
    tickets(ticket(1), ticket(2));
    const error = new Error('start failed');
    sdk.on(StartExecutionCommand).rejects(error);
    if (race) vi.mocked(revertClaim).mockRejectedValue(lostRace());
    await expect(callNext('demo', 'Desk 1')).rejects.toBe(error);
    expect(revertClaim).toHaveBeenCalledExactlyOnceWith('demo', 1);
    expect(claimTicket).toHaveBeenCalledTimes(1);
    expect(sdk.commandCalls(StartExecutionCommand)).toHaveLength(1);
  });

  it.each(['load', 'finish', 'claim'] as const)('propagates a nonconditional %s failure', async stage => {
    tickets(ticket(1, { status: 'serving', desk: 'Desk 1' }), ticket(2));
    const error = new Error(`${stage} failed`);
    if (stage === 'load') vi.mocked(loadOffice).mockRejectedValue(error);
    if (stage === 'finish') vi.mocked(finishServing).mockRejectedValue(error);
    if (stage === 'claim') vi.mocked(claimTicket).mockRejectedValue(error);
    await expect(callNext('demo', 'Desk 1')).rejects.toBe(error);
    expect(sdk.calls()).toHaveLength(0);
  });

  it('logs a nonconditional revert failure and preserves the start error', async () => {
    tickets(ticket(1), ticket(2));
    const startError = new Error('start failed');
    const revertError = new Error('revert failed');
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    sdk.on(StartExecutionCommand).rejects(startError);
    vi.mocked(revertClaim).mockRejectedValue(revertError);
    await expect(callNext('demo', 'Desk 1')).rejects.toBe(startError);
    expect(log).toHaveBeenCalledExactlyOnceWith('callNext: revert failed', 'demo', 1, revertError);
    expect(revertClaim).toHaveBeenCalledExactlyOnceWith('demo', 1);
    expect(claimTicket).toHaveBeenCalledTimes(1);
    expect(sdk.commandCalls(StartExecutionCommand)).toHaveLength(1);
  });

  it('reads the confirm window from rules on each call', async () => {
    tickets(ticket(42));
    vi.stubEnv('CONFIRM_WINDOW_SECONDS', '45');
    await callNext('demo', 'Desk 1');
    expect(sdk.commandCalls(StartExecutionCommand)[0]?.args[0].input.input).toBe(
      JSON.stringify({ ...input, confirmWindowSeconds: 45 }),
    );
  });
});

describe('Step Functions wrappers', () => {
  it('exports the SFN client and starts with the current ARN, execution name and exact JSON input', async () => {
    expect(sfn).toBeInstanceOf(SFNClient);
    await expect(startCall(input, now)).resolves.toBeUndefined();
    vi.stubEnv('STATE_MACHINE_ARN', 'arn:aws:states:af-south-1:123456789012:stateMachine:other');
    await startCall(input, now + 1);
    expect(sdk.commandCalls(StartExecutionCommand).map(call => call.args[0].input)).toEqual([
      { stateMachineArn: 'arn:aws:states:af-south-1:123456789012:stateMachine:called-ticket',
        name: `demo-42-${now}`, input: JSON.stringify(input) },
      { stateMachineArn: process.env.STATE_MACHINE_ARN, name: `demo-42-${now + 1}`, input: JSON.stringify(input) },
    ]);
  });

  it('throws StartExecution errors unchanged', async () => {
    const error = new Error('start failed');
    sdk.on(StartExecutionCommand).rejects(error);
    await expect(startCall(input, now)).rejects.toBe(error);
  });

  it('sends the confirmation output and failure details unchanged and returns ok', async () => {
    const taskToken = randomUUID();
    const output = { confirmedAt: iso };
    await expect(succeedTask(taskToken, output)).resolves.toBe('ok');
    expect(sdk.commandCalls(SendTaskSuccessCommand)[0]?.args[0].input).toEqual({ taskToken, output: JSON.stringify(output) });
    await expect(failTask(taskToken, 'Patron.Left', 'patron left')).resolves.toBe('ok');
    expect(sdk.commandCalls(SendTaskFailureCommand)[0]?.args[0].input).toEqual({ taskToken, error: 'Patron.Left', cause: 'patron left' });
  });

  it.each(['TaskTimedOut', 'TaskDoesNotExist', 'InvalidToken'])('maps %s to dead for both callbacks', async name => {
    const error = Object.assign(new Error('closed'), { name });
    sdk.on(SendTaskSuccessCommand).rejects(error);
    sdk.on(SendTaskFailureCommand).rejects(error);
    await expect(succeedTask(randomUUID(), { confirmedAt: iso })).resolves.toBe('dead');
    await expect(failTask(randomUUID(), 'Patron.Left', 'patron left')).resolves.toBe('dead');
  });

  it('throws other callback errors unchanged', async () => {
    const error = new Error('network failed');
    sdk.on(SendTaskSuccessCommand).rejects(error);
    sdk.on(SendTaskFailureCommand).rejects(error);
    await expect(succeedTask(randomUUID(), { confirmedAt: iso })).rejects.toBe(error);
    await expect(failTask(randomUUID(), 'Patron.Left', 'patron left')).rejects.toBe(error);
  });
});
