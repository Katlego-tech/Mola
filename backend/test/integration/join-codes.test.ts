import { randomBytes, randomUUID } from 'node:crypto';
import { CreateTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { beforeAll, describe, expect, inject, it } from 'vitest';

let db: typeof import('../../src/lib/db');
const code = () => randomBytes(12).toString('base64url');
const ttl = 120_000;

beforeAll(async () => {
  const endpoint = inject('dynamodbEndpoint');
  process.env.AWS_ENDPOINT_URL_DYNAMODB = endpoint;
  process.env.AWS_REGION = 'af-south-1';
  process.env.AWS_ACCESS_KEY_ID = 'local';
  process.env.AWS_SECRET_ACCESS_KEY = 'local';
  process.env.TABLE_NAME = `mola-join-${Date.now()}`;
  await new DynamoDBClient({ endpoint }).send(new CreateTableCommand({
    TableName: process.env.TABLE_NAME,
    BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }, { AttributeName: 'sk', AttributeType: 'S' }],
    KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }, { AttributeName: 'sk', KeyType: 'RANGE' }],
  }));
  db = await import('../../src/lib/db');
});

describe('single-use join codes', () => {
  it('issues exactly one ticket for ten concurrent attempts with the same code', async () => {
    const officeId = 'concurrent-joins';
    const now = Date.now();
    const live = await db.ensureJoinCode(officeId, code(), now, ttl);
    const results = await Promise.allSettled(Array.from({ length: 10 }, async () => {
      const ticketNo = await db.consumeJoinCode(officeId, live.code, code(), now + 1, ttl);
      await db.putTicket({
        officeId, ticketNo, status: 'waiting', queueKey: ticketNo, secretHash: randomUUID(),
        misses: 0, createdAt: new Date(now).toISOString(), expiresAt: Math.floor(now / 1000) + 3600,
      });
      return ticketNo;
    }));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    for (const result of results) {
      if (result.status === 'rejected') expect(result.reason).toMatchObject({ name: 'ConditionalCheckFailedException' });
    }
    const snapshot = await db.loadOffice(officeId);
    expect(snapshot.tickets).toHaveLength(1);
    expect(snapshot.office?.ticketCounter).toBe(1);
    expect(snapshot.office?.joinCode).not.toBe(live.code);
    expect(snapshot.office?.joinCodeIssuedAt).toBe(now + 1);
  });

  it.each(['absent', 'expired'])('returns the same code to two screens when the code is %s', async state => {
    const officeId = `screens-${state}`;
    const now = Date.now();
    if (state === 'expired') await db.ensureJoinCode(officeId, code(), now - ttl, ttl);
    const [first, second] = await Promise.all([
      db.ensureJoinCode(officeId, code(), now, ttl),
      db.ensureJoinCode(officeId, code(), now, ttl),
    ]);
    expect(first).toEqual(second);
    expect(first.issuedAt).toBe(now);
    expect((await db.loadOffice(officeId)).office?.joinCode).toBe(first.code);
  });

  it('expires at exactly the time limit without incrementing the counter', async () => {
    const officeId = 'expiry-boundary';
    const now = Date.now();
    const live = await db.ensureJoinCode(officeId, code(), now, ttl);
    await expect(db.consumeJoinCode(officeId, live.code, code(), now + ttl, ttl))
      .rejects.toMatchObject({ name: 'ConditionalCheckFailedException' });
    expect((await db.loadOffice(officeId)).office?.ticketCounter).toBeUndefined();
    expect(await db.consumeJoinCode(officeId, live.code, code(), now + ttl - 1, ttl)).toBe(1);
  });
});
