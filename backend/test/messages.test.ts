import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseClientMessage } from '../src/lib/messages';
import type { ClientMessage } from '../src/lib/messages';

const secret = randomUUID();
const messages: ClientMessage[] = [
  { action: 'ask', ticketNo: 42, secret, question: 'Bring ID?', lang: 'zu' },
  { action: 'notes', lang: 'af' },
  { action: 'saveNotes', text: '', baseVersion: 0, staffKey: randomUUID() },
  { action: 'daySummary', staffKey: randomUUID() },
  { action: 'join', code: randomUUID().replaceAll('-', '').slice(0, 16) },
  { action: 'join', staffKey: randomUUID() },
  { action: 'watch', staffKey: randomUUID() },
  { action: 'refreshJoinCode' },
  { action: 'resume', ticketNo: 42, secret },
  { action: 'confirm', ticketNo: 42, secret },
  { action: 'leave', ticketNo: 42, secret },
  { action: 'watch' },
  { action: 'ping' },
  { action: 'callNext', desk: 'Desk 2', staffKey: '…' },
];

describe('parseClientMessage', () => {
  it.each(messages)('parses $action', (message) => {
    expect(parseClientMessage(JSON.stringify(message))).toEqual(message);
  });

  it.each([undefined, '', ' ', '{', '{"action":"join",}', 'undefined'])('refuses missing or invalid JSON: %s', (body) => {
      expect(parseClientMessage(body)).toEqual({ error: 'bad_request' });
    });

  it.each([null, true, false, 42, 'join', [], [{ action: 'join' }], {},
    { action: null }, { action: 42 }, { action: true }, { action: [] }, { action: {} }])('refuses a non-object body or missing/non-string action: %j', (body) => {
      expect(parseClientMessage(JSON.stringify(body))).toEqual({ error: 'bad_request' });
    });

  it.each(['', 'unknown', 'Join', 'toString', '__proto__'])('reports an unknown string action: %s', (action) => {
      expect(parseClientMessage(JSON.stringify({ action }))).toEqual({ error: 'unknown_action' });
    });

  it.each(messages)('refuses extra fields on $action', (message) => {
    for (const field of ['extra', 'ticketNo', 'secret', 'desk', 'staffKey', '__proto__']) {
      if (!Object.hasOwn(message, field) && !(message.action === 'watch' && field === 'staffKey')) {
        expect(parseClientMessage(JSON.stringify({ ...message, [field]: 'extra' })))
          .toEqual({ error: 'bad_request' });
      }
    }
  });

  it('refuses an own __proto__ field in raw JSON', () => {
    expect(parseClientMessage('{"action":"join","__proto__":{}}'))
      .toEqual({ error: 'bad_request' });
  });

  it.each(['resume', 'confirm', 'leave'] as const)('requires a positive safe integer ticketNo and string secret for %s', (action) => {
      for (const ticketNo of [undefined, null, '42', true, 0, -0, -1, 1.5, 1e308, 2 ** 53, [], {}, Infinity]) {
        expect(parseClientMessage(JSON.stringify({ action, ticketNo, secret })))
          .toEqual({ error: 'bad_request' });
      }
      for (const invalidSecret of [undefined, null, 42, true, [], {}]) {
        expect(parseClientMessage(JSON.stringify({ action, ticketNo: 42, secret: invalidSecret })))
          .toEqual({ error: 'bad_request' });
      }
      for (const ticketNo of ['-0', '1e400', '9007199254740993']) {
        expect(parseClientMessage(`{"action":"${action}","ticketNo":${ticketNo},"secret":${JSON.stringify(secret)}}`))
          .toEqual({ error: 'bad_request' });
      }
    });

  it.each(['resume', 'confirm', 'leave'] as const)('accepts positive safe integer boundaries for %s', (action) => {
      for (const ticketNo of [1, Number.MAX_SAFE_INTEGER]) {
        const message = { action, ticketNo, secret };
        expect(parseClientMessage(JSON.stringify(message))).toEqual(message);
      }
    });

  it.each(['resume', 'confirm', 'leave'] as const)('requires secret length 1 to 128 for %s', (action) => {
    const generatedSecret = randomUUID().repeat(4);
    for (const length of [1, 128]) {
      const message = { action, ticketNo: 42, secret: generatedSecret.slice(0, length) };
      expect(parseClientMessage(JSON.stringify(message))).toEqual(message);
    }
    for (const length of [0, 129, 144]) {
      expect(parseClientMessage(JSON.stringify({
        action, ticketNo: 42, secret: generatedSecret.slice(0, length),
      }))).toEqual({ error: 'bad_request' });
    }
  });

  it.each([undefined, null, 42, true, [], {}, '', 'a'.repeat(21), 'Desk_2',
    'Desk.2', 'Désk', 'Desk\t2', 'Desk\n2', 'Desk\n'])('refuses a missing, non-string, or invalid desk: %j', (desk) => {
      expect(parseClientMessage(JSON.stringify({ action: 'callNext', desk, staffKey: 'key' })))
        .toEqual({ error: 'bad_request' });
    });

  it.each(['a', 'Z', '0', '-', ' ', 'Az09 -'.padEnd(20, 'x')])('accepts a desk matching the specified character and length limits: %j', (desk) => {
      const message = { action: 'callNext', desk, staffKey: randomUUID() };
      expect(parseClientMessage(JSON.stringify(message))).toEqual(message);
    });

  it.each([undefined, null, 42, true, [], {}])('requires a string staffKey: %j', (staffKey) => {
      expect(parseClientMessage(JSON.stringify({ action: 'callNext', desk: 'Desk 2', staffKey })))
        .toEqual({ error: 'bad_request' });
    });

  it('requires staffKey length 1 to 128', () => {
    const generatedKey = randomUUID().repeat(4);
    for (const length of [1, 128]) {
      const message = { action: 'callNext', desk: 'Desk 2', staffKey: generatedKey.slice(0, length) };
      expect(parseClientMessage(JSON.stringify(message))).toEqual(message);
    }
    for (const length of [0, 129, 144]) {
      expect(parseClientMessage(JSON.stringify({
        action: 'callNext', desk: 'Desk 2', staffKey: generatedKey.slice(0, length),
      }))).toEqual({ error: 'bad_request' });
    }
  });

  it('accepts exactly 1024 bytes and refuses 1025 bytes, including JSON whitespace', () => {
    const body = JSON.stringify({ action: 'ping' });
    expect(parseClientMessage(body.padEnd(1024))).toEqual({ action: 'ping' });
    expect(parseClientMessage(body.padEnd(1025))).toEqual({ error: 'bad_request' });
  });

  it('measures the body limit in UTF-8 bytes', () => {
    const message = { action: 'resume', ticketNo: 42, secret: `${randomUUID()}é` };
    const body = JSON.stringify(message);
    expect(Buffer.byteLength(body)).toBeLessThan(1024);
    const atLimit = body.padEnd(body.length + 1024 - Buffer.byteLength(body));
    expect(Buffer.byteLength(atLimit)).toBe(1024);
    expect(parseClientMessage(atLimit)).toEqual(message);
    expect(parseClientMessage(`${atLimit} `)).toEqual({ error: 'bad_request' });
  });
});


describe('assist message boundaries', () => {
  it('trims questions before applying length limits', () => {
    const message = { action: 'ask', ticketNo: 1, secret, question: '  Bring ID?  ', lang: 'en' };
    expect(parseClientMessage(JSON.stringify(message))).toEqual({ ...message, question: 'Bring ID?' });
    for (const question of ['', '   ', 'a'.repeat(301)]) {
      expect(parseClientMessage(JSON.stringify({ ...message, question }))).toEqual({ error: 'bad_request' });
    }
    expect(parseClientMessage(JSON.stringify({ ...message, question: 'a'.repeat(300) }))).not.toHaveProperty('error');
  });
  it('accepts full Unicode notes and refuses excess text or invalid versions', () => {
    const message = { action: 'saveNotes', text: '界'.repeat(4000), baseVersion: 0, staffKey: randomUUID() };
    expect(parseClientMessage(JSON.stringify(message))).toEqual(message);
    for (const text of ['a'.repeat(4001), 42, null]) {
      expect(parseClientMessage(JSON.stringify({ ...message, text }))).toEqual({ error: 'bad_request' });
    }
    for (const baseVersion of [-1, 1.5, 2 ** 53, null, '0']) {
      expect(parseClientMessage(JSON.stringify({ ...message, baseVersion }))).toEqual({ error: 'bad_request' });
    }
  });
  it('refuses unknown languages', () => {
    for (const lang of ['fr', 'toString', null, 1]) {
      expect(parseClientMessage(JSON.stringify({ action: 'notes', lang }))).toEqual({ error: 'bad_request' });
      expect(parseClientMessage(JSON.stringify({ action: 'ask', ticketNo: 1, secret, question: 'ID?', lang }))).toEqual({ error: 'bad_request' });
    }
  });
});

it.each([{}, { code: '' }, { code: 'x'.repeat(15) }, { code: 'x'.repeat(17) }, { code: '!'.repeat(16) }, { staffKey: '' }, { code: 'x'.repeat(16), staffKey: randomUUID() }])('refuses invalid join credentials %j', fields => {
  expect(parseClientMessage(JSON.stringify({ action: 'join', ...fields }))).toEqual({ error: 'bad_request' });
});
