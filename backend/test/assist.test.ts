import { createHash, randomUUID } from 'node:crypto';
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handler } from '../src/handlers/assist';
import { issueSecret } from '../src/lib/secret';
import { send } from '../src/lib/ws';
import type { Ticket } from '../src/lib/model';

vi.mock('../src/lib/ws', () => ({ send: vi.fn() }));
const db = mockClient(DynamoDBDocumentClient);
const bedrock = mockClient(BedrockRuntimeClient);
const now = Date.parse('2026-11-16T12:00:00Z');
let secret: string;
let staffKey: string;
let ticket: Ticket;
const event = (message: object) => ({ requestContext: { routeKey: 'ask', connectionId: 'phone' }, body: JSON.stringify(message) });
const ask = () => ({ action: 'ask', ticketNo: 42, secret, question: 'Bring ID?', lang: 'en' });
const condition = () => Object.assign(new Error('refused'), { name: 'ConditionalCheckFailedException' });
function toolAnswer(found: boolean, answer: string) {
  bedrock.on(ConverseCommand).resolves({ output: { message: { role: 'assistant', content: [{ toolUse: { toolUseId: 'answer-call', name: 'answer', input: { found, answer } } }] } } });
}
function textAnswer(text: string) {
  bedrock.on(ConverseCommand).resolves({ output: { message: { role: 'assistant', content: [{ text }] } } });
}
function notes(text: string | null) {
  db.on(GetCommand, { Key: { pk: 'NOTES#clinic', sk: 'TEXT' } }).resolves(text === null ? {} : { Item: { version: 3, text } });
}
async function run(message: object) {
  await expect(handler(event(message))).resolves.toEqual({ statusCode: 200 });
  expect(send).toHaveBeenCalledTimes(1);
  return vi.mocked(send).mock.calls[0]?.[1];
}

beforeEach(() => {
  db.reset(); bedrock.reset(); vi.resetAllMocks();
  vi.spyOn(Date, 'now').mockReturnValue(now);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const issued = issueSecret(); secret = issued.secret;
  staffKey = randomUUID();
  vi.stubEnv('STAFF_KEY_SHA256', createHash('sha256').update(staffKey).digest('hex'));
  vi.stubEnv('TABLE_NAME', 'assist-tests');
  ticket = { officeId: 'clinic', ticketNo: 42, queueKey: 42, status: 'waiting', secretHash: issued.secretHash,
    misses: 0, createdAt: new Date(now).toISOString(), expiresAt: now / 1000 + 3600 };
  db.on(GetCommand).resolves({});
  db.on(GetCommand, { Key: { pk: 'CONN#phone', sk: 'META' } }).resolves({ Item: { connectionId: 'phone', officeId: 'clinic', role: 'patron' } });
  db.on(QueryCommand).callsFake(() => ({ Items: [{ ...ticket, pk: 'OFFICE#clinic', sk: 'TICKET#000042' }] }));
  db.on(UpdateCommand).resolves({ Attributes: { asks: 1 } });
  db.on(PutCommand).resolves({});
  notes('Bring ID and 2 copies.');
  vi.mocked(send).mockResolvedValue('sent');
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('asking the office', () => {
  it('returns a found answer only to the asking connection with the remaining allowance', async () => {
    toolAnswer(true, 'Bring ID and 2 copies.');
    expect(await run(ask())).toEqual({ type: 'answer', question: 'Bring ID?', found: true, answer: 'Bring ID and 2 copies.', asksLeft: 9 });
    expect(send).toHaveBeenCalledWith('phone', expect.any(Object));
    expect(JSON.stringify(bedrock.call(0).args[0].input)).not.toContain(secret);
  });
  it('returns not found with a null answer', async () => {
    toolAnswer(false, 'No answer');
    expect(await run(ask())).toMatchObject({ found: false, answer: null });
  });
  it.each([null, ''])('does not call Bedrock when notes are %s', async text => {
    notes(text);
    expect(await run(ask())).toMatchObject({ found: false, answer: null, asksLeft: 9 });
    expect(bedrock.calls()).toHaveLength(0);
  });
  it('rejects an ungrounded number without refunding', async () => {
    toolAnswer(true, 'Bring 7 copies.');
    expect(await run(ask())).toMatchObject({ found: false, answer: null });
    expect(db.commandCalls(UpdateCommand)).toHaveLength(1);
  });
  it('allows a number supplied only in the question', async () => {
    toolAnswer(true, 'Bring 4 copies.');
    expect(await run({ ...ask(), question: 'Can I bring 4 copies?' })).toMatchObject({ found: true });
  });
  it('refunds a throttled question and reports unavailable without allowance', async () => {
    bedrock.on(ConverseCommand).rejects(Object.assign(new Error('throttled'), { name: 'ThrottlingException' }));
    expect(await run(ask())).toMatchObject({ type: 'error', code: 'assist_unavailable' });
    expect(db.commandCalls(UpdateCommand)[1]?.args[0].input).toMatchObject({ UpdateExpression: 'ADD asks :minus' });
  });
  it('keeps a failed refund best effort', async () => {
    bedrock.on(ConverseCommand).rejects(new Error('unavailable'));
    db.on(UpdateCommand, { UpdateExpression: 'ADD asks :minus' }).rejects(condition());
    expect(await run(ask())).toMatchObject({ code: 'assist_unavailable' });
  });
  it.each<object>([{}, { found: true, answer: 4 }, { found: true, answer: 'a'.repeat(601) }])('refunds malformed tool input %j', async input => {
    bedrock.on(ConverseCommand).resolves({ output: { message: { role: 'assistant', content: [{ toolUse: { toolUseId: 'answer-call', name: 'answer', input: input as Record<string, string | number | boolean> } }] } } });
    expect(await run(ask())).toMatchObject({ code: 'assist_unavailable' });
    expect(db.commandCalls(UpdateCommand)).toHaveLength(2);
  });
  it('reports the reservation limit and skips Bedrock', async () => {
    db.on(UpdateCommand).rejects(condition());
    expect(await run(ask())).toMatchObject({ code: 'ask_limit' });
    expect(bedrock.calls()).toHaveLength(0);
  });
  it('refuses the wrong secret before reserving', async () => {
    expect(await run({ ...ask(), secret: randomUUID() })).toMatchObject({ code: 'bad_ticket' });
    expect(db.commandCalls(UpdateCommand)).toHaveLength(0);
  });
  it.each(['done', 'left', 'no_show'] as const)('refuses an inactive %s ticket', async status => {
    ticket.status = status;
    expect(await run(ask())).toMatchObject({ code: 'bad_ticket' });
    expect(db.commandCalls(UpdateCommand)).toHaveLength(0);
  });
  it.each(['called', 'serving'] as const)('allows an active %s ticket', async status => {
    ticket.status = status; toolAnswer(false, '');
    expect(await run(ask())).toMatchObject({ type: 'answer' });
  });
});

describe('reading office notes', () => {
  it('serves English directly', async () => {
    expect(await run({ action: 'notes', lang: 'en' })).toEqual({ type: 'notes', lang: 'en', version: 3, text: 'Bring ID and 2 copies.', translated: false });
    expect(bedrock.calls()).toHaveLength(0);
  });
  it.each([null, ''])('uses English for missing or empty notes %s', async text => {
    notes(text);
    expect(await run({ action: 'notes', lang: 'zu' })).toMatchObject({ lang: 'en', version: text === null ? 0 : 3, text: '', translated: false });
    expect(bedrock.calls()).toHaveLength(0);
  });
  it('serves a cached translation without calling Bedrock', async () => {
    db.on(GetCommand, { Key: { pk: 'NOTES#clinic', sk: 'LANG#zu#000003' } }).resolves({ Item: { text: 'Letha 2' } });
    expect(await run({ action: 'notes', lang: 'zu' })).toMatchObject({ lang: 'zu', text: 'Letha 2', translated: true });
    expect(bedrock.calls()).toHaveLength(0);
  });
  it('translates a cache miss and puts it once with a thirty day expiry', async () => {
    textAnswer('Letha 2');
    expect(await run({ action: 'notes', lang: 'zu' })).toMatchObject({ lang: 'zu', text: 'Letha 2', translated: true });
    expect(db.commandCalls(PutCommand)).toHaveLength(1);
    expect(db.commandCalls(PutCommand)[0]?.args[0].input.Item).toMatchObject({ version: 3, lang: 'zu', expiresAt: now / 1000 + 30 * 86400 });
    expect(bedrock.call(0).args[0].input).toMatchObject({ inferenceConfig: { maxTokens: 2000, temperature: 0 } });
  });
  it('ignores only a lost cache put race', async () => {
    textAnswer('Letha 2'); db.on(PutCommand).rejects(condition());
    expect(await run({ action: 'notes', lang: 'zu' })).toMatchObject({ translated: true });
  });
  it.each(['number', 'Bedrock'] as const)('falls back to English on %s failure', async failure => {
    if (failure === 'number') textAnswer('Letha 3');
    else bedrock.on(ConverseCommand).rejects(new Error('unavailable'));
    expect(await run({ action: 'notes', lang: 'zu' })).toMatchObject({ lang: 'en', text: 'Bring ID and 2 copies.', translated: false });
    expect(db.commandCalls(PutCommand)).toHaveLength(0);
  });
});

describe('day summary', () => {
  beforeEach(() => {
    db.on(GetCommand, { Key: { pk: 'CONN#phone', sk: 'META' } }).resolves({ Item: { connectionId: 'phone', officeId: 'clinic', role: 'screen' } });
  });
  it('returns computed zero statistics without calling Bedrock', async () => {
    db.on(QueryCommand).resolves({ Items: [] });
    expect(await run({ action: 'daySummary', staffKey })).toMatchObject({ type: 'summary', stats: { issued: 0 }, text: null });
    expect(bedrock.calls()).toHaveLength(0);
  });
  it.each(['number', 'Bedrock'] as const)('keeps computed statistics when %s fails', async failure => {
    if (failure === 'number') textAnswer('There were 999 tickets.');
    else bedrock.on(ConverseCommand).rejects(new Error('unavailable'));
    expect(await run({ action: 'daySummary', staffKey })).toMatchObject({ type: 'summary', stats: { issued: 1, waitingNow: 1 }, text: null });
  });
  it('accepts a summary with a busiest-hour interval', async () => {
    textAnswer('1 ticket was issued from 14:00 to 15:00.');
    expect(await run({ action: 'daySummary', staffKey })).toMatchObject({ text: '1 ticket was issued from 14:00 to 15:00.' });
    expect(bedrock.call(0).args[0].input).toMatchObject({ inferenceConfig: { maxTokens: 400, temperature: 0 } });
  });
  it('refuses a wrong staff key before loading tickets', async () => {
    expect(await run({ action: 'daySummary', staffKey: randomUUID() })).toMatchObject({ code: 'forbidden' });
    expect(db.commandCalls(QueryCommand)).toHaveLength(0);
  });
  it('refuses a patron with a valid staff key', async () => {
    db.on(GetCommand, { Key: { pk: 'CONN#phone', sk: 'META' } }).resolves({ Item: { officeId: 'clinic', role: 'patron' } });
    expect(await run({ action: 'daySummary', staffKey })).toMatchObject({ code: 'forbidden' });
  });
});

it('requires a session', async () => {
  db.on(GetCommand).resolves({});
  expect(await run({ action: 'notes', lang: 'en' })).toMatchObject({ code: 'no_session' });
});
it('rejects unexpected actions', async () => {
  expect(await run({ action: 'watch' })).toMatchObject({ code: 'unknown_action' });
});
it('rejects malformed messages before reading a session', async () => {
  expect(await run({ action: 'notes', lang: 'fr' })).toMatchObject({ code: 'bad_request' });
  expect(db.calls()).toHaveLength(0);
});
