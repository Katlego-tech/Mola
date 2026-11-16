#!/usr/bin/env node
// Drives a deployed Mola stack end to end over its WebSocket, as a screen and patrons do.
//
//   node scripts/smoke.mjs --url wss://<api>.execute-api.<region>.amazonaws.com/prod
//        [--office smoke-<time>] --staff-key KEY [--desk "Desk 1"] [--timeout] [--assist] [--site https://...]
//
// A screen watches, two patrons join (positions 1 and 2), one drops its
// connection and resumes the same ticket. The desk calls the first patron,
// who confirms (serving); then calls the second. With --timeout as well: the second patron does
// not confirm, and the script waits out the confirm window for the drop-back. Finally the second
// patron leaves. Exits non-zero at the first step that does not happen.
// With --assist and --staff-key: also checks saved notes, answers, translation, and daily stats.
// Uses Node's built-in WebSocket (Node 24).

import { readFile } from 'node:fs/promises';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, arg, i, all) => {
    if (arg.startsWith('--')) pairs.push([arg.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]);
    return pairs;
  }, []),
);
if (!args.url || typeof args['staff-key'] !== 'string') {
  console.error('usage: node scripts/smoke.mjs --url wss://... [--office id] --staff-key KEY [--desk "Desk 1"] [--timeout] [--assist] [--site https://...]');
  process.exit(2);
}
const office = args.office ?? `smoke-${Date.now().toString(36)}`;
const desk = args.desk ?? 'Desk 1';
const WAIT_MS = 10_000;

let step = 0;
function ok(what) {
  step += 1;
  console.log(`  ok ${step}  ${what}`);
}
function fail(what) {
  console.error(`  FAILED  ${what}`);
  process.exit(1);
}

/** A client that queues every message, so a test can wait for the next one matching a filter. */
function client(role) {
  const ws = new WebSocket(`${args.url}?office=${office}&role=${role}`);
  const inbox = [];
  const waiters = [];
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    const i = waiters.findIndex((w) => w.match(msg));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
    else inbox.push(msg);
  };
  const opened = new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error(`${role} connection refused`));
  });
  return {
    opened,
    send: (msg) => ws.send(JSON.stringify(msg)),
    close: () => ws.close(),
    next(match, label, ms = WAIT_MS) {
      const i = inbox.findIndex(match);
      if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
      return new Promise((resolve) => {
        const timer = setTimeout(() => fail(`timed out waiting for ${label}`), ms);
        waiters.push({ match, resolve: (m) => { clearTimeout(timer); resolve(m); } });
      });
    },
  };
}
const statusOf = (ticketNo, status) => (m) => m.type === 'status' && m.ticket.ticketNo === ticketNo && (!status || m.ticket.status === status);

console.log(`Smoke test against ${args.url} (office ${office})`);

const screen = client('screen');
await screen.opened;
screen.send({ action: 'watch' });
const first = await screen.next((m) => m.type === 'board', 'the first board');
if (first.board.officeId !== office || first.board.waitingCount !== 0) fail(`empty board expected, got ${JSON.stringify(first.board)}`);
ok('a screen watches and receives the empty board');

const a = client('patron');
await a.opened;
a.send({ action: 'join', staffKey: args['staff-key'] });
const ta = await a.next((m) => m.type === 'ticket', 'patron A ticket');
const sa = await a.next(statusOf(ta.ticketNo, 'waiting'), 'patron A status');
if (sa.ticket.position !== 1) fail(`patron A should be position 1, got ${sa.ticket.position}`);
ok(`patron A takes ticket ${ta.ticketNo} at position 1`);

const b = client('patron');
await b.opened;
b.send({ action: 'join', staffKey: args['staff-key'] });
const tb = await b.next((m) => m.type === 'ticket', 'patron B ticket');
if (tb.ticketNo === ta.ticketNo) fail('two patrons got the same ticket number');
const sb = await b.next(statusOf(tb.ticketNo, 'waiting'), 'patron B status');
if (sb.ticket.position !== 2) fail(`patron B should be position 2, got ${sb.ticket.position}`);
ok(`patron B takes ticket ${tb.ticketNo} at position 2`);

a.close();
const a2 = client('patron');
await a2.opened;
a2.send({ action: 'resume', ticketNo: ta.ticketNo, secret: ta.secret });
const ra = await a2.next(statusOf(ta.ticketNo), 'patron A resume');
if (ra.ticket.status !== 'waiting' || ra.ticket.position !== 1) fail(`resume should restore position 1, got ${JSON.stringify(ra.ticket)}`);
a2.send({ action: 'resume', ticketNo: ta.ticketNo, secret: tb.secret });
await a2.next((m) => m.type === 'error' && m.code === 'bad_ticket', 'refusal of a wrong secret');
ok('patron A reconnects and resumes the same ticket; a wrong secret is refused');

if (args['staff-key']) {
  const staff = client('screen');
  await staff.opened;
  staff.send({ action: 'callNext', desk, staffKey: args['staff-key'] });
  const called = await a2.next((m) => statusOf(ta.ticketNo, 'called')(m) && m.ticket.deadline !== null, 'patron A called with a deadline', 20_000);
  if (called.ticket.desk !== desk) fail(`patron A should be called to ${desk}`);
  ok(`the desk calls patron A to ${desk}`);

  if (args.assist) {
    screen.send({ action: 'speak', what: 'call', ticketNo: ta.ticketNo });
    const speech = await screen.next((m) => m.type === 'speech' || m.type === 'error', 'called-ticket speech', 60_000);
    if (speech.type === 'error' || speech.what !== 'call' || speech.ticketNo !== ta.ticketNo
      || !/^\/voice\/[a-f0-9]{64}\.mp3$/.test(speech.url)) fail('called-ticket speech was not returned');
    ok('assist returns audio for the called ticket');
    if (typeof args.site === 'string') {
      const siteUrl = args.site.replace(/\/$/, '');
      if (new URL(siteUrl).protocol !== 'https:') fail('--site must use HTTPS');
      const response = await fetch(`${siteUrl}${speech.url}`);
      if (response.status !== 200 || response.headers.get('content-type')?.split(';')[0] !== 'audio/mpeg') {
        fail(`speech fetch returned ${response.status} ${response.headers.get('content-type')}`);
      }
      await response.arrayBuffer();
      ok('the site serves called-ticket audio as audio/mpeg');
    } else {
      console.log('     speech URL fetch skipped: provide --site https://... to check delivery');
    }
  }

  a2.send({ action: 'confirm', ticketNo: ta.ticketNo, secret: ta.secret });
  await a2.next(statusOf(ta.ticketNo, 'serving'), 'patron A serving');
  ok('patron A confirms and is being served');

  staff.send({ action: 'callNext', desk, staffKey: args['staff-key'] });
  const calledB = await b.next((m) => statusOf(tb.ticketNo, 'called')(m) && m.ticket.deadline !== null, 'patron B called', 20_000);
  ok(`the desk calls patron B (patron A's visit closes)`);

  if (args.timeout) {
    const windowMs = calledB.board.rules.confirmWindowSeconds * 1000;
    console.log(`     waiting ${windowMs / 1000}s for patron B's window to run out`);
    await b.next((m) => m.type === 'notice' && (m.code === 'dropped_back' || m.code === 'no_show'), 'the missed-turn notice', windowMs + 20_000);
    ok('patron B misses the window and is told');
  }

  b.send({ action: 'leave', ticketNo: tb.ticketNo, secret: tb.secret });
  await b.next(statusOf(tb.ticketNo, 'left'), 'patron B left');
  ok('patron B leaves the queue');
  staff.close();
}

if (args.assist) {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/eval-clinic.json', import.meta.url), 'utf8'));
  async function assistRequest(c, msg, match, label) {
    c.send(msg);
    const reply = await c.next((m) => m.type === 'error' || match(m), label, 60_000);
    if (reply.type === 'error') throw new Error(`${label}: ${reply.code}`);
    return reply;
  }
  let ticket;
  let failed = false;
  try {
    const notes = await assistRequest(screen, { action: 'notes', lang: 'en' }, (m) => m.type === 'notes', 'current notes');
    const saved = await assistRequest(screen, { action: 'saveNotes', text: fixture.notes, baseVersion: notes.version, staffKey: args['staff-key'] }, (m) => m.type === 'notes', 'saved notes');
    if (saved.text !== fixture.notes || saved.version !== notes.version + 1) throw new Error('saved notes did not match');
    ok('staff saves clinic notes');

    const read = await assistRequest(screen, { action: 'notes', lang: 'en' }, (m) => m.type === 'notes', 'notes read back');
    if (read.text !== fixture.notes || read.version !== saved.version) throw new Error('notes read back did not match');
    ok('saved notes read back with the same text and version');

    ticket = await assistRequest(b, { action: 'join', staffKey: args['staff-key'] }, (m) => m.type === 'ticket', 'assist ticket');
    const credentials = { ticketNo: ticket.ticketNo, secret: ticket.secret };
    const answerable = fixture.cases.find((item) => item.kind === 'answerable');
    const answer = await assistRequest(b, { action: 'ask', ...credentials, question: answerable.question, lang: answerable.lang }, (m) => m.type === 'answer' && m.question === answerable.question, 'answerable question');
    if (answer.found !== true) throw new Error('answerable question was not answered');
    ok('assist answers a question covered by the notes');

    const unanswerable = fixture.cases.find((item) => item.kind === 'unanswerable');
    const refusal = await assistRequest(b, { action: 'ask', ...credentials, question: unanswerable.question, lang: unanswerable.lang }, (m) => m.type === 'answer' && m.question === unanswerable.question, 'unanswerable question');
    if (refusal.found !== false) throw new Error('unanswerable question was answered');
    ok('assist declines a question outside the notes');

    const translated = await assistRequest(screen, { action: 'notes', lang: 'af' }, (m) => m.type === 'notes', 'Afrikaans notes');
    if (translated.translated !== true) throw new Error('Afrikaans notes were not translated');
    ok('notes are translated into Afrikaans');

    const summary = await assistRequest(screen, { action: 'daySummary', staffKey: args['staff-key'] }, (m) => m.type === 'summary', 'day summary');
    if (!summary.stats || typeof summary.stats !== 'object') throw new Error('day summary has no stats');
    ok('day summary includes computed stats');
  } catch (error) {
    console.error(`  FAILED  ${error.message}`);
    failed = true;
  } finally {
    if (ticket) {
      try {
        await assistRequest(b, { action: 'leave', ticketNo: ticket.ticketNo, secret: ticket.secret }, statusOf(ticket.ticketNo, 'left'), 'assist ticket left');
      } catch (error) {
        console.error(`  FAILED  ${error.message}`);
        failed = true;
      }
    }
  }
  if (failed) {
    for (const c of [screen, a2, b]) c.close();
    process.exit(1);
  }
}

for (const c of [screen, a2, b]) c.close();
console.log(`All ${step} steps passed.`);
process.exit(0);
