import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, QueryCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { Connection, Office, OfficeSnapshot, Screen, Ticket } from './model';

export const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const TABLE = () => process.env.TABLE_NAME;

export const officePk = (officeId: string) => `OFFICE#${officeId}`;
export const ticketSk = (ticketNo: number) => `TICKET#${String(ticketNo).padStart(6, '0')}`;
export const screenSk = (connectionId: string) => `SCREEN#${connectionId}`;
export const connKey = (connectionId: string) => ({ pk: `CONN#${connectionId}`, sk: 'META' });

export async function loadOffice(officeId: string): Promise<OfficeSnapshot> {
  const snapshot: OfficeSnapshot = { office: null, tickets: [], screens: [] };
  const nowSec = Date.now() / 1000;
  let cursor: Record<string, unknown> | undefined;
  do {
    const page = await ddb.send(new QueryCommand({
      TableName: TABLE(),
      ConsistentRead: true,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': officePk(officeId) },
      ...(cursor ? { ExclusiveStartKey: cursor } : {}),
    }));
    for (const item of page.Items ?? []) {
      const sk: unknown = item.sk;
      const entity = { ...item };
      delete entity.pk;
      delete entity.sk;
      if (sk === 'META') snapshot.office = entity as unknown as Office;
      else if (typeof sk === 'string' && sk.startsWith('TICKET#')) {
        const ticket = entity as unknown as Ticket;
        if (ticket.expiresAt > nowSec) snapshot.tickets.push(ticket);
      } else if (typeof sk === 'string' && sk.startsWith('SCREEN#')) {
        snapshot.screens.push(entity as unknown as Screen);
      }
    }
    cursor = page.LastEvaluatedKey;
  } while (cursor);
  return snapshot;
}

export async function getConnection(connectionId: string): Promise<Connection | null> {
  const { Item } = await ddb.send(new GetCommand({
    TableName: TABLE(), Key: connKey(connectionId), ConsistentRead: true,
  }));
  if (!Item) return null;
  const connection = { ...Item };
  delete connection.pk;
  delete connection.sk;
  return connection as unknown as Connection;
}

export async function nextTicketNo(officeId: string, nowIso: string): Promise<number> {
  const { Attributes } = await ddb.send(new UpdateCommand({
    TableName: TABLE(), Key: { pk: officePk(officeId), sk: 'META' },
    ReturnValues: 'UPDATED_NEW',
    UpdateExpression: 'SET officeId = if_not_exists(officeId, :o), createdAt = if_not_exists(createdAt, :now) ADD ticketCounter :one',
    ExpressionAttributeValues: { ':o': officeId, ':now': nowIso, ':one': 1 },
  }));
  return Attributes?.ticketCounter as number;
}

export async function putTicket(t: Ticket): Promise<void> {
  await ddb.send(new PutCommand({
    TableName: TABLE(), Item: { pk: officePk(t.officeId), sk: ticketSk(t.ticketNo), ...t },
    ConditionExpression: 'attribute_not_exists(pk)',
  }));
}

export async function setConnectionTicket(connectionId: string, ticketNo: number): Promise<void> {
  await ddb.send(new UpdateCommand({
    TableName: TABLE(), Key: connKey(connectionId),
    UpdateExpression: 'SET ticketNo = :n',
    ConditionExpression: 'attribute_exists(pk)',
    ExpressionAttributeValues: { ':n': ticketNo },
  }));
}

export async function bindTicketConnection(officeId: string, ticketNo: number, connectionId: string): Promise<void> {
  await ddb.send(new UpdateCommand({
    TableName: TABLE(), Key: { pk: officePk(officeId), sk: ticketSk(ticketNo) },
    UpdateExpression: 'SET connectionId = :c',
    ConditionExpression: 'attribute_exists(pk)',
    ExpressionAttributeValues: { ':c': connectionId },
  }));
}

export async function claimTicket(officeId: string, ticketNo: number, desk: string, calledAtIso: string): Promise<void> {
  await ddb.send(new UpdateCommand({
    TableName: TABLE(), Key: { pk: officePk(officeId), sk: ticketSk(ticketNo) },
    UpdateExpression: 'SET #s = :called, desk = :d, calledAt = :t',
    ConditionExpression: '#s = :waiting',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: { ':called': 'called', ':d': desk, ':t': calledAtIso, ':waiting': 'waiting' },
  }));
}

export async function revertClaim(officeId: string, ticketNo: number): Promise<void> {
  await ddb.send(new UpdateCommand({
    TableName: TABLE(), Key: { pk: officePk(officeId), sk: ticketSk(ticketNo) },
    UpdateExpression: 'SET #s = :waiting REMOVE desk, calledAt',
    ConditionExpression: '#s = :called',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: { ':waiting': 'waiting', ':called': 'called' },
  }));
}

export async function storeTaskToken(officeId: string, ticketNo: number, taskToken: string, deadlineMs: number): Promise<void> {
  await ddb.send(new UpdateCommand({
    TableName: TABLE(), Key: { pk: officePk(officeId), sk: ticketSk(ticketNo) },
    UpdateExpression: 'SET taskToken = :tk, deadline = :dl',
    ConditionExpression: '#s = :called',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: { ':tk': taskToken, ':dl': deadlineMs, ':called': 'called' },
  }));
}

export async function markServing(officeId: string, ticketNo: number, servedAtIso: string): Promise<void> {
  await ddb.send(new UpdateCommand({
    TableName: TABLE(), Key: { pk: officePk(officeId), sk: ticketSk(ticketNo) },
    UpdateExpression: 'SET #s = :serving, servedAt = :t REMOVE taskToken, deadline',
    ConditionExpression: '#s = :called',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: { ':serving': 'serving', ':t': servedAtIso, ':called': 'called' },
  }));
}

export async function finishServing(officeId: string, ticketNo: number, closedAtIso: string): Promise<void> {
  await ddb.send(new UpdateCommand({
    TableName: TABLE(), Key: { pk: officePk(officeId), sk: ticketSk(ticketNo) },
    UpdateExpression: 'SET #s = :done, closedAt = :t',
    ConditionExpression: '#s = :serving',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: { ':done': 'done', ':t': closedAtIso, ':serving': 'serving' },
  }));
}

export async function dropBack(officeId: string, ticketNo: number, queueKey: number, misses: number): Promise<void> {
  await ddb.send(new UpdateCommand({
    TableName: TABLE(), Key: { pk: officePk(officeId), sk: ticketSk(ticketNo) },
    UpdateExpression: 'SET #s = :waiting, queueKey = :k, misses = :m REMOVE desk, taskToken, deadline, calledAt',
    ConditionExpression: '#s = :called',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: { ':waiting': 'waiting', ':k': queueKey, ':m': misses, ':called': 'called' },
  }));
}

export async function markNoShow(officeId: string, ticketNo: number, misses: number, closedAtIso: string): Promise<void> {
  await ddb.send(new UpdateCommand({
    TableName: TABLE(), Key: { pk: officePk(officeId), sk: ticketSk(ticketNo) },
    UpdateExpression: 'SET #s = :no_show, closedAt = :t, misses = :m REMOVE taskToken, deadline',
    ConditionExpression: '#s = :called',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: { ':no_show': 'no_show', ':t': closedAtIso, ':m': misses, ':called': 'called' },
  }));
}

export async function markLeft(officeId: string, ticketNo: number, from: 'waiting' | 'called', closedAtIso: string): Promise<void> {
  await ddb.send(new UpdateCommand({
    TableName: TABLE(), Key: { pk: officePk(officeId), sk: ticketSk(ticketNo) },
    UpdateExpression: 'SET #s = :left, closedAt = :t REMOVE taskToken, deadline',
    ConditionExpression: '#s = :from',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: { ':left': 'left', ':t': closedAtIso, ':from': from },
  }));
}

export async function removeTicketConnection(officeId: string, ticketNo: number, connectionId: string): Promise<void> {
  await ddb.send(new UpdateCommand({
    TableName: TABLE(), Key: { pk: officePk(officeId), sk: ticketSk(ticketNo) },
    UpdateExpression: 'REMOVE connectionId',
    ConditionExpression: 'connectionId = :c',
    ExpressionAttributeValues: { ':c': connectionId },
  }));
}

export async function putConnection(c: Connection): Promise<void> {
  await ddb.send(new PutCommand({ TableName: TABLE(), Item: { ...connKey(c.connectionId), ...c } }));
}

export async function deleteConnection(connectionId: string): Promise<void> {
  await ddb.send(new DeleteCommand({ TableName: TABLE(), Key: connKey(connectionId) }));
}

export async function putScreen(s: Screen): Promise<void> {
  await ddb.send(new PutCommand({
    TableName: TABLE(), Item: { pk: officePk(s.officeId), sk: screenSk(s.connectionId), ...s },
  }));
}

export async function deleteScreen(officeId: string, connectionId: string): Promise<void> {
  await ddb.send(new DeleteCommand({
    TableName: TABLE(), Key: { pk: officePk(officeId), sk: screenSk(connectionId) },
  }));
}
