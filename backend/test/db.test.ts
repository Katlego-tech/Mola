import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as db from '../src/lib/db';
import type { Connection, Office, Screen, Ticket } from '../src/lib/model';

const mock = mockClient(DynamoDBDocumentClient);
const taskToken = crypto.randomUUID();
const iso = '2026-11-14T10:00:00.000Z';
const office: Office = { officeId: 'demo', ticketCounter: 42, createdAt: iso };
const ticket: Ticket = { officeId: 'demo', ticketNo: 42, status: 'waiting', queueKey: 42,
  secretHash: 'a'.repeat(64), misses: 0, createdAt: iso, expiresAt: 2000000000 };
const connection: Connection = { connectionId: 'c', officeId: 'demo', role: 'patron', expiresAt: 2000000000 };
const screen: Screen = { officeId: 'demo', connectionId: 's', trusted: false, expiresAt: 2000000000 };
const ticketKey = { pk: 'OFFICE#demo', sk: 'TICKET#000042' };

beforeEach(() => { mock.reset(); vi.stubEnv('TABLE_NAME', 'test-table'); });
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

describe('keys and reads', () => {
  it('builds the exact keys without truncating large ticket numbers', () => {
    expect(db.officePk('demo')).toBe('OFFICE#demo');
    expect(db.ticketSk(1)).toBe('TICKET#000001');
    expect(db.ticketSk(1234567)).toBe('TICKET#1234567');
    expect(db.screenSk('s')).toBe('SCREEN#s');
    expect(db.connKey('c')).toEqual({ pk: 'CONN#c', sk: 'META' });
  });

  it('reads every consistent Query page, strips keys and excludes expired tickets', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(iso));
    const now = Date.now() / 1000;
    const cursor = { pk: 'OFFICE#demo', sk: 'TICKET#000041' };
    mock.on(QueryCommand).resolvesOnce({ Items: [
      { pk: 'OFFICE#demo', sk: 'META', ...office },
      { pk: 'OFFICE#demo', sk: 'TICKET#000040', ...ticket, ticketNo: 40, expiresAt: now - 1 },
      { pk: 'OFFICE#demo', sk: 'TICKET#000041', ...ticket, ticketNo: 41, expiresAt: now },
    ], LastEvaluatedKey: cursor }).resolvesOnce({ Items: [
      { ...ticketKey, ...ticket }, { pk: 'OFFICE#demo', sk: 'SCREEN#s', ...screen },
    ] });
    expect(await db.loadOffice('demo')).toEqual({ office, tickets: [ticket], screens: [screen], readAt: Date.now() });
    expect(mock.commandCalls(QueryCommand).map(call => call.args[0].input)).toEqual([
      { TableName: 'test-table', ConsistentRead: true, KeyConditionExpression: 'pk = :pk', ExpressionAttributeValues: { ':pk': 'OFFICE#demo' } },
      { TableName: 'test-table', ConsistentRead: true, KeyConditionExpression: 'pk = :pk', ExpressionAttributeValues: { ':pk': 'OFFICE#demo' }, ExclusiveStartKey: cursor },
    ]);
  });

  it('follows an empty page and returns an empty snapshot for an absent office', async () => {
    mock.on(QueryCommand).resolvesOnce({ LastEvaluatedKey: ticketKey }).resolvesOnce({});
    expect(await db.loadOffice('demo')).toEqual({ office: null, tickets: [], screens: [], readAt: expect.any(Number) });
    expect(mock.commandCalls(QueryCommand)).toHaveLength(2);
  });

  it('gets a connection consistently, removes keys, and returns null when absent', async () => {
    mock.on(GetCommand).resolvesOnce({ Item: { pk: 'CONN#c', sk: 'META', ...connection } }).resolvesOnce({});
    expect(await db.getConnection('c')).toEqual(connection);
    expect(await db.getConnection('c')).toBeNull();
    expect(mock.commandCalls(GetCommand)[0]?.args[0].input).toEqual({ TableName: 'test-table', Key: { pk: 'CONN#c', sk: 'META' }, ConsistentRead: true });
  });

  it('propagates read failures unchanged', async () => {
    const error = new Error('unavailable');
    mock.on(QueryCommand).rejects(error);
    mock.on(GetCommand).rejects(error);
    await expect(db.loadOffice('demo')).rejects.toBe(error);
    await expect(db.getConnection('c')).rejects.toBe(error);
  });
});

const writes = [
  { name: 'nextTicketNo', run: () => db.nextTicketNo('demo', iso), command: UpdateCommand,
    input: { Key: { pk: 'OFFICE#demo', sk: 'META' }, ReturnValues: 'UPDATED_NEW',
      UpdateExpression: 'SET officeId = if_not_exists(officeId, :o), createdAt = if_not_exists(createdAt, :now) ADD ticketCounter :one',
      ExpressionAttributeValues: { ':o': 'demo', ':now': iso, ':one': 1 } } },
  { name: 'putTicket', run: () => db.putTicket(ticket), command: PutCommand,
    input: { Item: { ...ticketKey, ...ticket }, ConditionExpression: 'attribute_not_exists(pk)' } },
  { name: 'setConnectionTicket', run: () => db.setConnectionTicket('c', 42), command: UpdateCommand,
    input: { Key: { pk: 'CONN#c', sk: 'META' }, UpdateExpression: 'SET ticketNo = :n', ConditionExpression: 'attribute_exists(pk)',
      ExpressionAttributeValues: { ':n': 42 } } },
  { name: 'bindTicketConnection', run: () => db.bindTicketConnection('demo', 42, 'c'), command: UpdateCommand,
    input: { Key: ticketKey, UpdateExpression: 'SET connectionId = :c', ConditionExpression: 'attribute_exists(pk)',
      ExpressionAttributeValues: { ':c': 'c' } } },
  { name: 'claimTicket', run: () => db.claimTicket('demo', 42, 'Desk 1', iso), command: UpdateCommand,
    input: { Key: ticketKey, UpdateExpression: 'SET #s = :called, desk = :d, calledAt = :t', ConditionExpression: '#s = :waiting',
      ExpressionAttributeValues: { ':called': 'called', ':d': 'Desk 1', ':t': iso, ':waiting': 'waiting' }, ExpressionAttributeNames: { '#s': 'status' } } },
  { name: 'revertClaim', run: () => db.revertClaim('demo', 42), command: UpdateCommand,
    input: { Key: ticketKey, UpdateExpression: 'SET #s = :waiting REMOVE desk, calledAt, taskToken, deadline', ConditionExpression: '#s = :called',
      ExpressionAttributeValues: { ':waiting': 'waiting', ':called': 'called' }, ExpressionAttributeNames: { '#s': 'status' } } },
  { name: 'storeTaskToken', run: () => db.storeTaskToken('demo', 42, taskToken, 1234, iso), command: UpdateCommand,
    input: { Key: ticketKey, UpdateExpression: 'SET taskToken = :tk, deadline = :dl', ConditionExpression: '#s = :called AND calledAt = :c',
      ExpressionAttributeValues: { ':tk': taskToken, ':dl': 1234, ':called': 'called', ':c': iso }, ExpressionAttributeNames: { '#s': 'status' } } },
  { name: 'markServing', run: () => db.markServing('demo', 42, iso), command: UpdateCommand,
    input: { Key: ticketKey, UpdateExpression: 'SET #s = :serving, servedAt = :t REMOVE taskToken, deadline', ConditionExpression: '#s = :called',
      ExpressionAttributeValues: { ':serving': 'serving', ':t': iso, ':called': 'called' }, ExpressionAttributeNames: { '#s': 'status' } } },
  { name: 'finishServing', run: () => db.finishServing('demo', 42, iso), command: UpdateCommand,
    input: { Key: ticketKey, UpdateExpression: 'SET #s = :done, closedAt = :t', ConditionExpression: '#s = :serving',
      ExpressionAttributeValues: { ':done': 'done', ':t': iso, ':serving': 'serving' }, ExpressionAttributeNames: { '#s': 'status' } } },
  { name: 'dropBack', run: () => db.dropBack('demo', 42, 45.5, 1, iso), command: UpdateCommand,
    input: { Key: ticketKey, UpdateExpression: 'SET #s = :waiting, queueKey = :k, misses = :m REMOVE desk, taskToken, deadline, calledAt', ConditionExpression: '#s = :called AND calledAt = :c',
      ExpressionAttributeValues: { ':waiting': 'waiting', ':k': 45.5, ':m': 1, ':called': 'called', ':c': iso }, ExpressionAttributeNames: { '#s': 'status' } } },
  { name: 'markNoShow', run: () => db.markNoShow('demo', 42, 3, iso, iso), command: UpdateCommand,
    input: { Key: ticketKey, UpdateExpression: 'SET #s = :no_show, closedAt = :t, misses = :m REMOVE taskToken, deadline', ConditionExpression: '#s = :called AND calledAt = :c',
      ExpressionAttributeValues: { ':no_show': 'no_show', ':t': iso, ':m': 3, ':called': 'called', ':c': iso }, ExpressionAttributeNames: { '#s': 'status' } } },
  { name: 'markLeft', run: () => db.markLeft('demo', 42, 'waiting', iso), command: UpdateCommand,
    input: { Key: ticketKey, UpdateExpression: 'SET #s = :left, closedAt = :t REMOVE taskToken, deadline', ConditionExpression: '#s = :from',
      ExpressionAttributeValues: { ':left': 'left', ':t': iso, ':from': 'waiting' }, ExpressionAttributeNames: { '#s': 'status' } } },
  { name: 'markLeft', run: () => db.markLeft('demo', 42, 'called', iso), command: UpdateCommand,
    input: { Key: ticketKey, UpdateExpression: 'SET #s = :left, closedAt = :t REMOVE taskToken, deadline', ConditionExpression: '#s = :from',
      ExpressionAttributeValues: { ':left': 'left', ':t': iso, ':from': 'called' }, ExpressionAttributeNames: { '#s': 'status' } } },
  { name: 'removeTicketConnection', run: () => db.removeTicketConnection('demo', 42, 'c'), command: UpdateCommand,
    input: { Key: ticketKey, UpdateExpression: 'REMOVE connectionId', ConditionExpression: 'connectionId = :c',
      ExpressionAttributeValues: { ':c': 'c' } } },
  { name: 'putConnection', run: () => db.putConnection(connection), command: PutCommand,
    input: { Item: { pk: 'CONN#c', sk: 'META', ...connection } } },
  { name: 'deleteConnection', run: () => db.deleteConnection('c'), command: DeleteCommand,
    input: { Key: { pk: 'CONN#c', sk: 'META' } } },
  { name: 'putScreen', run: () => db.putScreen(screen), command: PutCommand,
    input: { Item: { pk: 'OFFICE#demo', sk: 'SCREEN#s', ...screen } } },
  { name: 'deleteScreen', run: () => db.deleteScreen('demo', 's'), command: DeleteCommand,
    input: { Key: { pk: 'OFFICE#demo', sk: 'SCREEN#s' } } },
];

describe('writes', () => {
  it.each(writes)('$name sends exactly the specified request and reads TABLE_NAME each call', async ({ run, input }) => {
    mock.onAnyCommand().resolves({ Attributes: { ticketCounter: 42 } });
    const result = await run();
    expect(result).toBe('ReturnValues' in input ? 42 : undefined);
    expect(mock.calls()).toHaveLength(1);
    expect(mock.call(0).args[0].input).toEqual({ TableName: 'test-table', ...input });
    vi.stubEnv('TABLE_NAME', 'another-table');
    await run();
    expect(mock.call(1).args[0].input).toEqual({ TableName: 'another-table', ...input });
  });

  it.each(writes)('$name uses its specified command', async ({ run, command }) => {
    mock.onAnyCommand().resolves({ Attributes: { ticketCounter: 42 } });
    await run();
    expect(mock.call(0).args[0]).toBeInstanceOf(command);
  });

  it.each(writes)('$name propagates ConditionalCheckFailedException unchanged', async ({ run }) => {
    const error = new ConditionalCheckFailedException({ message: 'race lost', $metadata: {} });
    mock.onAnyCommand().rejects(error);
    await expect(run()).rejects.toBe(error);
    expect(mock.calls()).toHaveLength(1);
  });
});


describe('assist persistence', () => {
  it('reads notes consistently from their own partition', async () => {
    mock.on(GetCommand).resolvesOnce({}).resolvesOnce({ Item: { version: 3, text: 'Bring ID' } });
    expect(await db.getNotes('clinic')).toBeNull();
    expect(await db.getNotes('clinic')).toEqual({ version: 3, text: 'Bring ID' });
    expect(mock.call(0).args[0].input).toEqual({ TableName: 'test-table', Key: { pk: 'NOTES#clinic', sk: 'TEXT' }, ConsistentRead: true });
  });
  it.each([0, 3])('saves text and version atomically from base %s', async base => {
    mock.on(TransactWriteCommand).resolves({});
    expect(await db.saveNotes('clinic', '', base, iso)).toBe(base + 1);
    expect(mock.commandCalls(TransactWriteCommand)[0]?.args[0].input.TransactItems).toEqual([
      { Update: { TableName: 'test-table', Key: { pk: 'OFFICE#clinic', sk: 'META' },
        UpdateExpression: 'SET notesVersion = :next, officeId = if_not_exists(officeId, :o), createdAt = if_not_exists(createdAt, :now)',
        ConditionExpression: base === 0 ? '(notesVersion = :base OR attribute_not_exists(notesVersion))' : 'notesVersion = :base',
        ExpressionAttributeValues: { ':next': base + 1, ':base': base, ':o': 'clinic', ':now': iso } } },
      { Put: { TableName: 'test-table', Item: { pk: 'NOTES#clinic', sk: 'TEXT', officeId: 'clinic', version: base + 1, text: '', updatedAt: iso } } },
    ]);
  });
  it('propagates a cancelled notes transaction', async () => {
    const error = Object.assign(new Error('conflict'), { name: 'TransactionCanceledException' });
    mock.on(TransactWriteCommand).rejects(error);
    await expect(db.saveNotes('clinic', 'New notes', 1, iso)).rejects.toBe(error);
  });
  it('uses versioned translation keys and immutable puts', async () => {
    mock.on(GetCommand).resolvesOnce({}).resolvesOnce({ Item: { text: 'Translated' } });
    expect(await db.getNotesTranslation('clinic', 'zu', 3)).toBeNull();
    expect(await db.getNotesTranslation('clinic', 'zu', 3)).toEqual({ text: 'Translated' });
    expect(mock.call(0).args[0].input).toMatchObject({ Key: { pk: 'NOTES#clinic', sk: 'LANG#zu#000003' } });
    mock.on(PutCommand).resolves({});
    await db.putNotesTranslation('clinic', 'zu', 3, 'Translated', 100);
    expect(mock.commandCalls(PutCommand)[0]?.args[0].input).toEqual({ TableName: 'test-table',
      Item: { pk: 'NOTES#clinic', sk: 'LANG#zu#000003', officeId: 'clinic', lang: 'zu', version: 3, text: 'Translated', expiresAt: 100 },
      ConditionExpression: 'attribute_not_exists(pk)' });
  });
  it('reserves an ask only for active tickets below the limit and returns the new count', async () => {
    mock.on(UpdateCommand).resolves({ Attributes: { asks: 4 } });
    expect(await db.reserveAsk('clinic', 42, 10)).toBe(4);
    expect(mock.call(0).args[0].input).toEqual({ TableName: 'test-table', Key: { pk: 'OFFICE#clinic', sk: 'TICKET#000042' },
      UpdateExpression: 'ADD asks :one', ReturnValues: 'UPDATED_NEW',
      ConditionExpression: '#s IN (:waiting, :called, :serving) AND (attribute_not_exists(asks) OR asks < :max)',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':one': 1, ':max': 10, ':waiting': 'waiting', ':called': 'called', ':serving': 'serving' } });
  });
  it('refunds only positive ask counts', async () => {
    mock.on(UpdateCommand).resolves({});
    await db.refundAsk('clinic', 42);
    expect(mock.call(0).args[0].input).toEqual({ TableName: 'test-table', Key: { pk: 'OFFICE#clinic', sk: 'TICKET#000042' },
      UpdateExpression: 'ADD asks :minus', ConditionExpression: 'asks > :zero',
      ExpressionAttributeValues: { ':minus': -1, ':zero': 0 } });
  });
});


it('timestamps the snapshot before the consistent query starts', async () => {
  vi.useFakeTimers({ now: new Date(iso) });
  const readAt = Date.now();
  mock.on(QueryCommand).callsFake(() => {
    vi.advanceTimersByTime(1000);
    return { Items: [] };
  });
  expect(await db.loadOffice('demo')).toEqual({ office: null, tickets: [], screens: [], readAt });
});

describe('join codes', () => {
  it('increments and rotates with a single conditional update', async () => {
    mock.on(UpdateCommand).resolves({ Attributes: { ticketCounter: 43 } });
    expect(await db.consumeJoinCode('clinic', 'old', 'new', 200_000, 120_000)).toBe(43);
    expect(mock.commandCalls(UpdateCommand)[0]?.args[0].input).toMatchObject({
      ReturnValues: 'UPDATED_NEW',
      ConditionExpression: 'joinCode = :code AND joinCodeIssuedAt > :cutoff',
      ExpressionAttributeValues: { ':code': 'old', ':new': 'new', ':now': 200_000, ':cutoff': 80_000, ':one': 1 },
    });
  });
  it('returns the winning code after another screen rotates first', async () => {
    mock.on(UpdateCommand).rejects(new ConditionalCheckFailedException({ $metadata: {}, message: 'Live' }));
    mock.on(GetCommand).resolves({ Item: { joinCode: 'winner', joinCodeIssuedAt: 200_000 } });
    expect(await db.ensureJoinCode('clinic', 'loser', 200_000, 120_000)).toEqual({ code: 'winner', issuedAt: 200_000 });
    expect(mock.commandCalls(GetCommand)[0]?.args[0].input.ConsistentRead).toBe(true);
  });
});

it('creates or renews a code only when absent or expired', async () => {
  mock.on(UpdateCommand).resolves({ Attributes: { joinCode: 'new', joinCodeIssuedAt: 200_000 } });
  expect(await db.ensureJoinCode('clinic', 'new', 200_000, 120_000)).toEqual({ code: 'new', issuedAt: 200_000 });
  expect(mock.commandCalls(UpdateCommand)[0]?.args[0].input).toMatchObject({
    ReturnValues: 'ALL_NEW',
    ConditionExpression: 'attribute_not_exists(joinCode) OR joinCodeIssuedAt <= :cutoff',
    ExpressionAttributeValues: { ':new': 'new', ':now': 200_000, ':o': 'clinic', ':iso': new Date(200_000).toISOString(), ':cutoff': 80_000 },
  });
  expect(mock.commandCalls(GetCommand)).toHaveLength(0);
});
