// Proves the ticket state machine (domain-model 5) with the real DynamoDB engine: every write
// function succeeds only from the state the model draws for it, lands in the drawn target state,
// and is refused by its own condition from every other state. No transition exists outside these
// functions, so an undrawn arrow is impossible rather than merely unimplemented.
import { CreateTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { beforeAll, describe, expect, inject, it } from 'vitest';
import type { Ticket, TicketStatus } from '../../src/lib/model';

const STATUSES: TicketStatus[] = ['waiting', 'called', 'serving', 'done', 'left', 'no_show'];
const OFFICE = 'proof';
const CALLED_AT = '2027-01-01T08:00:00.000Z';
const OTHER_CALL = '2027-01-01T08:05:00.000Z';
const NOW = '2027-01-01T08:01:00.000Z';

let db: typeof import('../../src/lib/db');
let next = 1;

beforeAll(async () => {
  const endpoint = inject('dynamodbEndpoint');
  process.env.AWS_ENDPOINT_URL_DYNAMODB = endpoint;
  process.env.AWS_REGION = 'af-south-1';
  process.env.AWS_ACCESS_KEY_ID = 'local';
  process.env.AWS_SECRET_ACCESS_KEY = 'local';
  process.env.TABLE_NAME = `mola-proof-${Date.now()}`;
  await new DynamoDBClient({ endpoint }).send(new CreateTableCommand({
    TableName: process.env.TABLE_NAME,
    BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }, { AttributeName: 'sk', AttributeType: 'S' }],
    KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }, { AttributeName: 'sk', KeyType: 'RANGE' }],
  }));
  db = await import('../../src/lib/db');
});

/** A fresh ticket in `status`; a called or serving one carries a desk, and a called one its call. */
async function seed(status: TicketStatus): Promise<number> {
  const ticketNo = next++;
  const ticket: Ticket = {
    officeId: OFFICE, ticketNo, status, queueKey: ticketNo, secretHash: 'a'.repeat(64), misses: 0,
    connectionId: `conn-${ticketNo}`, createdAt: NOW, expiresAt: 4_000_000_000,
    ...(status === 'called' ? { desk: 'Desk 1', calledAt: CALLED_AT, taskToken: 'tok-0', deadline: 1 } : {}),
    ...(status === 'serving' ? { desk: 'Desk 1' } : {}),
  };
  await db.putTicket(ticket);
  return ticketNo;
}

async function read(ticketNo: number): Promise<Ticket> {
  const snapshot = await db.loadOffice(OFFICE);
  const ticket = snapshot.tickets.find((t) => t.ticketNo === ticketNo);
  if (!ticket) throw new Error(`ticket ${ticketNo} missing`);
  return ticket;
}

async function refused(write: Promise<unknown>): Promise<void> {
  await expect(write).rejects.toMatchObject({ name: 'ConditionalCheckFailedException' });
}

interface Transition {
  write: string;
  from: TicketStatus;
  to: TicketStatus;
  run(ticketNo: number, calledAt: string): Promise<void>;
  /** Fields the write must remove (invariant 3: a token exists only while called). */
  removes?: (keyof Ticket)[];
  /** The write is also guarded by the call's identity. */
  guardsCall?: boolean;
}

// The drawn arrows of domain-model 5, each as the one function that performs it.
const TRANSITIONS: Transition[] = [
  { write: 'claimTicket', from: 'waiting', to: 'called', run: (n) => db.claimTicket(OFFICE, n, 'Desk 2', NOW) },
  { write: 'revertClaim', from: 'called', to: 'waiting', run: (n) => db.revertClaim(OFFICE, n), removes: ['desk', 'calledAt', 'taskToken', 'deadline'] },
  { write: 'storeTaskToken', from: 'called', to: 'called', run: (n, c) => db.storeTaskToken(OFFICE, n, 'tok-1', 2, c), guardsCall: true },
  { write: 'markServing', from: 'called', to: 'serving', run: (n) => db.markServing(OFFICE, n, NOW), removes: ['taskToken', 'deadline'] },
  { write: 'finishServing', from: 'serving', to: 'done', run: (n) => db.finishServing(OFFICE, n, NOW) },
  { write: 'dropBack', from: 'called', to: 'waiting', run: (n, c) => db.dropBack(OFFICE, n, 1.5, 1, c), removes: ['desk', 'taskToken', 'deadline', 'calledAt'], guardsCall: true },
  { write: 'markNoShow', from: 'called', to: 'no_show', run: (n, c) => db.markNoShow(OFFICE, n, 3, NOW, c), removes: ['taskToken', 'deadline'], guardsCall: true },
  { write: 'markLeft(waiting)', from: 'waiting', to: 'left', run: (n) => db.markLeft(OFFICE, n, 'waiting', NOW) },
  { write: 'markLeft(called)', from: 'called', to: 'left', run: (n) => db.markLeft(OFFICE, n, 'called', NOW), removes: ['taskToken', 'deadline'] },
];

describe.each(TRANSITIONS)('$write', (t) => {
  it(`moves a ${t.from} ticket to ${t.to}`, async () => {
    const n = await seed(t.from);
    await t.run(n, CALLED_AT);
    const after = await read(n);
    expect(after.status).toBe(t.to);
    for (const field of t.removes ?? []) expect(after[field]).toBeUndefined();
  });

  it.each(STATUSES.filter((s) => s !== t.from))(`is refused from %s, and changes nothing`, async (status) => {
    const n = await seed(status);
    const before = await read(n);
    await refused(t.run(n, CALLED_AT));
    expect(await read(n)).toEqual(before);
  });

  if (t.guardsCall) {
    it('is refused for a different call of the same ticket', async () => {
      const n = await seed('called');
      const before = await read(n);
      await refused(t.run(n, OTHER_CALL));
      expect(await read(n)).toEqual(before);
    });
  }
});

describe('the other guarded writes', () => {
  it('never issues the same ticket twice', async () => {
    const n = await seed('waiting');
    await refused(db.putTicket({ ...(await read(n)), status: 'waiting' }));
  });

  it('only removes a connection that still holds the ticket', async () => {
    const n = await seed('waiting');
    await refused(db.removeTicketConnection(OFFICE, n, 'someone-else'));
    await db.removeTicketConnection(OFFICE, n, `conn-${n}`);
    expect((await read(n)).connectionId).toBeUndefined();
  });

  it('never binds to a ticket or connection that does not exist', async () => {
    await refused(db.bindTicketConnection(OFFICE, 999_999, 'conn-x'));
    await refused(db.setConnectionTicket('never-connected', 1));
  });

  it('counts tickets atomically under concurrent joins', async () => {
    const numbers = await Promise.all(Array.from({ length: 25 }, () => db.nextTicketNo('counter-office', NOW)));
    expect(new Set(numbers).size).toBe(25);
    expect(Math.max(...numbers)).toBe(25);
  });
});
