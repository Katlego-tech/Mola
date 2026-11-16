#!/usr/bin/env node
// Measures the latency goal on a deployed stack: when the board changes, how long until every
// connected phone has heard about it? The goal is p95 <= 1 s.
//
//   node scripts/load.mjs --url wss://... --staff-key KEY [--clients 100] [--rounds 5] [--batch 5]
//   Add --broadcast-log FILE to report queue latency from JSON-lines broadcaster logs for this run.
//
// Opens --clients patron connections that each take a ticket in a fresh office, then a screen calls
// the next patron --rounds times, from a different desk each round (a desk still calling someone
// is busy). For each call it times, per phone, the gap from the moment the
// call was sent to the first status that phone receives afterwards. Reports p50, p95 and max over
// every phone and round, and exits non-zero if p95 is over 1 s. Every phone leaves the queue at the end.

import { readFileSync } from 'node:fs';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, arg, i, all) => {
    if (arg.startsWith('--')) pairs.push([arg.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]);
    return pairs;
  }, []),
);
if (!args.url || !args['staff-key']) {
  console.error('usage: node scripts/load.mjs --url wss://... --staff-key KEY [--clients 100] [--rounds 5]');
  process.exit(2);
}
const clients = Number(args.clients ?? 100);
const BATCH = Number(args.batch ?? 5);
const rounds = Number(args.rounds ?? 5);
const office = `load-${Date.now().toString(36)}`;
const GOAL_MS = 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connectOnce(role) {
  const ws = new WebSocket(`${args.url}?office=${office}&role=${role}`);
  const listeners = new Set();
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    for (const l of listeners) l(msg);
  };
  return new Promise((resolve, reject) => {
    ws.onopen = () => resolve({ ws, listeners, send: (m) => ws.send(JSON.stringify(m)) });
    ws.onerror = () => reject(new Error(`${role} connection refused`));
  });
}

/** A refused connect is retried a few times: a new AWS account allows only 10 concurrent Lambdas. */
async function connect(role) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await connectOnce(role);
    } catch (error) {
      if (attempt === 5) throw error;
      await sleep(500 * attempt);
    }
  }
}
const phones = [];
let staff = null;
/** Every phone that holds a ticket leaves, five at a time, each waiting for its `left` status, so
 *  the office does not keep re-calling unconfirmed tickets after the test. */
async function cleanup() {
  const holders = phones.filter((p) => p.ticket);
  let confirmed = 0;
  for (let i = 0; i < holders.length; i += BATCH) {
    await Promise.all(holders.slice(i, i + BATCH).map((p) => new Promise((resolve) => {
      const timer = setTimeout(() => { p.listeners.delete(onLeft); resolve(); }, 10_000);
      function onLeft(m) {
        if (m.type !== 'status' || m.ticket.ticketNo !== p.ticket.ticketNo || m.ticket.status !== 'left') return;
        p.listeners.delete(onLeft); // count each phone once, however many broadcasts repeat it
        confirmed += 1;
        clearTimeout(timer);
        resolve();
      }
      p.listeners.add(onLeft);
      p.send({ action: 'leave', ...p.ticket });
    })));
  }
  if (holders.length) console.log(`  cleanup: ${confirmed} of ${holders.length} tickets left the queue`);
  for (const p of [...phones, ...(staff ? [staff] : [])]) p.ws.close();
}
let failing = false;
async function fail(why) {
  console.error(`  FAILED  ${why}`);
  if (failing) return; // the first failure is already cleaning up and will exit
  failing = true;
  await cleanup();
  process.exit(1);
}

console.log(`Load test: ${clients} phones, ${rounds} calls, office ${office}`);
// Five at a time: the joins each broadcast to every phone, and the account's Lambda concurrency
// is the real ceiling here, not the code.
for (let i = 0; i < clients; i += BATCH) {
  phones.push(...(await Promise.all(Array.from({ length: Math.min(BATCH, clients - i) }, () => connect('patron')))));
}
const join = (p, i) => new Promise((resolve) => {
  const timer = setTimeout(() => fail(`phone ${i} got no ticket within 15 s`), 15_000);
  const onReply = (m) => {
    if (m.type === 'error') fail(`phone ${i} could not join: ${m.code}`);
    // API Gateway answers a failed or throttled integration with its own frame, not one of ours.
    if (m.type === undefined) fail(`phone ${i}: API Gateway said ${JSON.stringify(m)}`);
    if (m.type !== 'ticket') return;
    clearTimeout(timer);
    p.ticket = { ticketNo: m.ticketNo, secret: m.secret };
    p.listeners.delete(onReply);
    resolve();
  };
  p.listeners.add(onReply);
  p.send({ action: 'join', staffKey: args['staff-key'] });
});
for (let i = 0; i < phones.length; i += BATCH) {
  await Promise.all(phones.slice(i, i + BATCH).map((p, j) => join(p, i + j)));
}
console.log(`  ${phones.length} phones hold tickets`);
await sleep(2000); // let the joins' broadcasts drain before measuring

staff = await connect('screen');
const samples = [];
for (let round = 1; round <= rounds; round += 1) {
  const desk = `Load ${round}`;
  const sentAt = performance.now();
  // Only a status whose board shows this round's desk calling answers this call; a late status from
  // the joins or an earlier round does not count.
  const heard = phones.map((p) => new Promise((resolve) => {
    const timer = setTimeout(() => { p.listeners.delete(on); resolve(Infinity); }, 10_000);
    function on(m) {
      if (m.type !== 'status' || !m.board.calling.some((c) => c.desk === desk)) return;
      clearTimeout(timer);
      p.listeners.delete(on);
      resolve(performance.now() - sentAt);
    }
    p.listeners.add(on);
  }));
  staff.send({ action: 'callNext', desk, staffKey: args['staff-key'] });
  const times = await Promise.all(heard);
  samples.push(...times);
  await sleep(1500);
  console.log(`  round ${round}: slowest phone ${Math.round(Math.max(...times))} ms`);
}

// Phones that never heard a call count as slower than everything (Infinity), so p95 is never flattered.
const sorted = [...samples].sort((x, y) => x - y);
const missed = samples.filter((t) => !Number.isFinite(t)).length;
const pct = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
const ms = (t) => (Number.isFinite(t) ? `${Math.round(t)} ms` : 'never');
const p95 = pct(0.95);
console.log(`\n  phones x rounds: ${samples.length}, never heard within 10 s: ${missed}`);
console.log(`  p50 ${ms(pct(0.5))}   p95 ${ms(p95)}   max ${ms(sorted.at(-1))}   (goal: p95 <= ${GOAL_MS} ms)`);
// Queue latency is measured on the server; the WebSocket snapshot cannot isolate it.
if (args['broadcast-log']) {
  const queueSamples = [];
  for (const line of readFileSync(args['broadcast-log'], 'utf8').split('\n').filter((line) => line.trim())) {
    let message;
    try {
      const entry = JSON.parse(line);
      message = typeof entry?.message === 'string' ? JSON.parse(entry.message) : entry?.message ?? entry;
    } catch {
      continue; // Runtime and error logs can appear alongside the structured latency entries.
    }
    if (!message) continue;
    if (message.event === 'broadcast_queue_latency' && message.officeId === office &&
      Number.isFinite(message.queueLatencyMs) && message.queueLatencyMs >= 0) {
      queueSamples.push(message.queueLatencyMs);
    }
  }
  queueSamples.sort((x, y) => x - y);
  if (queueSamples.length) {
    const queueP95 = queueSamples[Math.min(queueSamples.length - 1, Math.floor(0.95 * queueSamples.length))];
    console.log(`  queue component: p95 ${ms(queueP95)}, max ${ms(queueSamples.at(-1))} (${queueSamples.length} office batches)`);
    console.log('  queue and phone samples are separate; their percentiles do not form an exact latency share');
  } else {
    console.log('  queue component: no latency logs visible for this office');
  }
} else {
  console.log('  queue component: not visible over WebSocket; supply --broadcast-log with broadcaster JSON-lines logs');
}
await cleanup();
process.exit(missed === 0 && p95 <= GOAL_MS ? 0 : 1);
