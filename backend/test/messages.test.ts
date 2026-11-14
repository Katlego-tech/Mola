import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseClientMessage } from '../src/lib/messages';
import type { ClientMessage } from '../src/lib/messages';

const secret = randomUUID();
const messages: ClientMessage[] = [
  { action: 'join' },
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
      if (!Object.hasOwn(message, field)) {
        expect(parseClientMessage(JSON.stringify({ ...message, [field]: 'extra' })))
          .toEqual({ error: 'bad_request' });
      }
    }
  });

  it.each(['resume', 'confirm', 'leave'] as const)('requires an integer ticketNo and string secret for %s', (action) => {
      for (const ticketNo of [undefined, null, '42', true, 1.5, [], {}, Infinity]) {
        expect(parseClientMessage(JSON.stringify({ action, ticketNo, secret })))
          .toEqual({ error: 'bad_request' });
      }
      for (const invalidSecret of [undefined, null, 42, true, [], {}]) {
        expect(parseClientMessage(JSON.stringify({ action, ticketNo: 42, secret: invalidSecret })))
          .toEqual({ error: 'bad_request' });
      }
      expect(parseClientMessage(`{"action":"${action}","ticketNo":1e400,"secret":"secret"}`))
        .toEqual({ error: 'bad_request' });
    });

  it.each(['resume', 'confirm', 'leave'] as const)('does not impose additional ticket number or secret restrictions on %s', (action) => {
      for (const ticketNo of [0, -1]) {
        const message = { action, ticketNo, secret: '' };
        expect(parseClientMessage(JSON.stringify(message))).toEqual(message);
      }
    });

  it.each([undefined, null, 42, true, [], {}, '', 'a'.repeat(21), 'Desk_2',
    'Desk.2', 'Désk', 'Desk\t2', 'Desk\n2', 'Desk\n'])('refuses a missing, non-string, or invalid desk: %j', (desk) => {
      expect(parseClientMessage(JSON.stringify({ action: 'callNext', desk, staffKey: 'key' })))
        .toEqual({ error: 'bad_request' });
    });

  it.each(['a', 'Z', '0', '-', ' ', 'Az09 -'.padEnd(20, 'x')])('accepts a desk matching the specified character and length limits: %j', (desk) => {
      const message = { action: 'callNext', desk, staffKey: '' };
      expect(parseClientMessage(JSON.stringify(message))).toEqual(message);
    });

  it.each([undefined, null, 42, true, [], {}])('requires a string staffKey: %j', (staffKey) => {
      expect(parseClientMessage(JSON.stringify({ action: 'callNext', desk: 'Desk 2', staffKey })))
        .toEqual({ error: 'bad_request' });
    });

  it('accepts exactly 1024 bytes and refuses 1025 bytes, including JSON whitespace', () => {
    const body = JSON.stringify({ action: 'join' });
    expect(parseClientMessage(body.padEnd(1024))).toEqual({ action: 'join' });
    expect(parseClientMessage(body.padEnd(1025))).toEqual({ error: 'bad_request' });
  });

  it('measures the body limit in UTF-8 bytes', () => {
    const message = { action: 'resume', ticketNo: 42, secret: 'é'.repeat(480) };
    const body = JSON.stringify(message);
    expect(Buffer.byteLength(body)).toBeLessThan(1024);
    const atLimit = body.padEnd(body.length + 1024 - Buffer.byteLength(body));
    expect(Buffer.byteLength(atLimit)).toBe(1024);
    expect(parseClientMessage(atLimit)).toEqual(message);
    expect(parseClientMessage(`${atLimit} `)).toEqual({ error: 'bad_request' });
  });
});
