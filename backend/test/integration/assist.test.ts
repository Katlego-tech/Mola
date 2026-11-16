import { randomUUID } from 'node:crypto';
import { CreateTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { beforeAll, describe, expect, inject, it } from 'vitest';
import type { Ticket, TicketStatus } from '../../src/lib/model';

const NOW = '2026-11-16T10:00:00.000Z';
let db: typeof import('../../src/lib/db');
let next = 1;

beforeAll(async () => {
  const endpoint = inject('dynamodbEndpoint');
  process.env.AWS_ENDPOINT_URL_DYNAMODB = endpoint;
  process.env.AWS_REGION = 'af-south-1';
  process.env.AWS_ACCESS_KEY_ID = 'local';
  process.env.AWS_SECRET_ACCESS_KEY = 'local';
  process.env.TABLE_NAME = `mola-assist-${Date.now()}`;
  await new DynamoDBClient({ endpoint }).send(new CreateTableCommand({
    TableName: process.env.TABLE_NAME, BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }, { AttributeName: 'sk', AttributeType: 'S' }],
    KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }, { AttributeName: 'sk', KeyType: 'RANGE' }],
  }));
  db = await import('../../src/lib/db');
});

async function seed(status: TicketStatus, asks?: number): Promise<number> {
  const ticketNo = next++;
  await db.putTicket({ officeId: 'clinic', ticketNo, status, queueKey: ticketNo,
    secretHash: randomUUID(), misses: 0, createdAt: NOW, expiresAt: 4_000_000_000,
    ...(asks === undefined ? {} : { asks }),
  });
  return ticketNo;
}

async function read(ticketNo: number): Promise<Ticket | undefined> {
  return (await db.loadOffice('clinic')).tickets.find(ticket => ticket.ticketNo === ticketNo);
}

describe('ask reservations', () => {
  it.each(['waiting', 'called', 'serving'] as const)('reserves and refunds from %s without changing queue state', async status => {
    const ticketNo = await seed(status);
    const before = await read(ticketNo);
    expect(await db.reserveAsk('clinic', ticketNo, 10)).toBe(1);
    expect(await read(ticketNo)).toEqual({ ...before, asks: 1 });
    await db.refundAsk('clinic', ticketNo);
    expect(await read(ticketNo)).toEqual({ ...before, asks: 0 });
    await expect(db.refundAsk('clinic', ticketNo)).rejects.toMatchObject({ name: 'ConditionalCheckFailedException' });
    expect((await read(ticketNo))?.asks).toBe(0);
  });
  it.each(['done', 'left', 'no_show'] as const)('refuses %s and changes nothing', async status => {
    const ticketNo = await seed(status);
    const before = await read(ticketNo);
    await expect(db.reserveAsk('clinic', ticketNo, 10)).rejects.toMatchObject({ name: 'ConditionalCheckFailedException' });
    expect(await read(ticketNo)).toEqual(before);
  });
  it('allows the last ask, refuses the limit and permits another after a refund', async () => {
    const ticketNo = await seed('waiting', 9);
    expect(await db.reserveAsk('clinic', ticketNo, 10)).toBe(10);
    const before = await read(ticketNo);
    await expect(db.reserveAsk('clinic', ticketNo, 10)).rejects.toMatchObject({ name: 'ConditionalCheckFailedException' });
    expect(await read(ticketNo)).toEqual(before);
    await db.refundAsk('clinic', ticketNo);
    expect(await db.reserveAsk('clinic', ticketNo, 10)).toBe(10);
  });
  it('cannot refund a missing count or create a ticket by reserving', async () => {
    const ticketNo = await seed('waiting');
    await expect(db.refundAsk('clinic', ticketNo)).rejects.toMatchObject({ name: 'ConditionalCheckFailedException' });
    await expect(db.reserveAsk('clinic', 999999, 10)).rejects.toMatchObject({ name: 'ConditionalCheckFailedException' });
    expect(await read(999999)).toBeUndefined();
  });
});

describe('atomic office notes', () => {
  it('refuses a stale base without changing either text or office metadata', async () => {
    const officeId = 'stale-office';
    expect(await db.saveNotes(officeId, 'Original', 0, NOW)).toBe(1);
    const before = await db.loadOffice(officeId);
    const notes = await db.getNotes(officeId);
    await expect(db.saveNotes(officeId, 'Overwrite', 0, NOW)).rejects.toMatchObject({ name: 'TransactionCanceledException' });
    expect(await db.loadOffice(officeId)).toEqual(before);
    expect(await db.getNotes(officeId)).toEqual(notes);
  });
  it('allows exactly one concurrent save from a shared base and keeps its text and version together', async () => {
    const officeId = 'concurrent-office';
    await db.saveNotes(officeId, 'Original', 0, NOW);
    const texts = ['First editor', 'Second editor'];
    const results = await Promise.allSettled(texts.map(text => db.saveNotes(officeId, text, 1, NOW)));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const loser = results.find(result => result.status === 'rejected');
    expect(loser).toMatchObject({ reason: { name: 'TransactionCanceledException' } });
    const winner = results.findIndex(result => result.status === 'fulfilled');
    expect(await db.getNotes(officeId)).toEqual({ version: 2, text: texts[winner] });
    expect((await db.loadOffice(officeId)).office?.notesVersion).toBe(2);
  });
  it('can save empty notes and start from an explicit zero version', async () => {
    const officeId = 'empty-notes-office';
    const { PutCommand } = await import('@aws-sdk/lib-dynamodb');
    await db.ddb.send(new PutCommand({ TableName: process.env.TABLE_NAME,
      Item: { pk: db.officePk(officeId), sk: 'META', officeId, createdAt: NOW, notesVersion: 0 } }));
    expect(await db.saveNotes(officeId, '', 0, NOW)).toBe(1);
    expect(await db.getNotes(officeId)).toEqual({ version: 1, text: '' });
    expect((await db.loadOffice(officeId)).office?.notesVersion).toBe(1);
  });
  it('never overwrites a cached translation for the same language and version', async () => {
    const officeId = 'translation-office';
    await db.putNotesTranslation(officeId, 'zu', 3, 'First translation', 4_000_000_000);
    await expect(db.putNotesTranslation(officeId, 'zu', 3, 'Second translation', 4_000_000_000))
      .rejects.toMatchObject({ name: 'ConditionalCheckFailedException' });
    expect(await db.getNotesTranslation(officeId, 'zu', 3)).toEqual({ text: 'First translation' });
  });
});
