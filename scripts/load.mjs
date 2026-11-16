#!/usr/bin/env node
// Measures the latency goal on a deployed stack: when the board changes, how long until every
// connected phone has heard about it? The goal is p95 <= 1 s.
//
//   node scripts/load.mjs --url wss://... --staff-key KEY [--clients 100] [--rounds 5] [--batch 5]
//
// Opens --clients patron connections that each take a ticket in a fresh office, then a screen calls
// the next patron --rounds times, from a different desk each round (a desk still calling someone
// is busy). For each call it times, per phone, the gap from the moment the
// call was sent to the first status that phone receives afterwards. Reports p50, p95 and max over
// every phone and round, and exits non-zero if p95 is over 1 s. Every phone leaves the queue at the end.

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
function fail(why) {
  console.error(`  FAILED  ${why}`);
  process.exit(1);
}

console.log(`Load test: ${clients} phones, ${rounds} calls, office ${office}`);
const phones = [];
// Five at a time: the joins each broadcast to every phone, and the account's Lambda concurrency
// is the real ceiling here, not the code.
const BATCH = Number(args.batch ?? 5);
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
  p.send({ action: 'join' });
});
for (let i = 0; i < phones.length; i += BATCH) {
  await Promise.all(phones.slice(i, i + BATCH).map((p, j) => join(p, i + j)));
}
console.log(`  ${phones.length} phones hold tickets`);
await sleep(2000); // let the joins' broadcasts drain before measuring

const staff = await connect('screen');
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

const sorted = samples.filter(Number.isFinite).sort((x, y) => x - y);
const missed = samples.length - sorted.length;
const pct = (q) => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]);
console.log(`\n  phones x rounds: ${samples.length}, never heard within 10 s: ${missed}`);
console.log(`  p50 ${pct(0.5)} ms   p95 ${pct(0.95)} ms   max ${Math.round(sorted.at(-1))} ms   (goal: p95 <= ${GOAL_MS} ms)`);
// Leave the queue, so the office does not keep re-calling 100 unconfirmed tickets after the test.
for (const p of phones) if (p.ticket) p.send({ action: 'leave', ...p.ticket });
await sleep(5000);
for (const p of [...phones, staff]) p.ws.close();
process.exit(missed === 0 && pct(0.95) <= GOAL_MS ? 0 : 1);
