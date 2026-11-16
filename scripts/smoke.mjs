#!/usr/bin/env node
// Drives a deployed Mola stack end to end over its WebSocket, the way the demo does.
//
//   node scripts/smoke.mjs --url wss://<api>.execute-api.<region>.amazonaws.com/prod
//        [--office smoke-<time>] [--staff-key KEY] [--desk "Desk 1"] [--timeout]
//
// Without --staff-key: a screen watches, two patrons join (positions 1 and 2), one drops its
// connection and resumes the same ticket. With --staff-key: the desk calls the first patron,
// who confirms (serving); then calls the second. With --timeout as well: the second patron does
// not confirm, and the script waits out the confirm window for the drop-back. Finally the second
// patron leaves. Exits non-zero at the first step that does not happen.
// Uses Node's built-in WebSocket (Node 22+).

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, arg, i, all) => {
    if (arg.startsWith('--')) pairs.push([arg.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]);
    return pairs;
  }, []),
);
if (!args.url) {
  console.error('usage: node scripts/smoke.mjs --url wss://... [--office id] [--staff-key KEY] [--desk "Desk 1"] [--timeout]');
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
a.send({ action: 'join' });
const ta = await a.next((m) => m.type === 'ticket', 'patron A ticket');
const sa = await a.next(statusOf(ta.ticketNo, 'waiting'), 'patron A status');
if (sa.ticket.position !== 1) fail(`patron A should be position 1, got ${sa.ticket.position}`);
ok(`patron A takes ticket ${ta.ticketNo} at position 1`);

const b = client('patron');
await b.opened;
b.send({ action: 'join' });
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

for (const c of [screen, a2, b]) c.close();
console.log(`All ${step} steps passed.`);
process.exit(0);
