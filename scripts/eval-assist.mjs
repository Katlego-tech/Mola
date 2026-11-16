#!/usr/bin/env node
// Evaluates clinic answers, refusal of unrelated questions, and notes translations on a stack.
//
//   node scripts/eval-assist.mjs --url wss://... --staff-key KEY
//        [--office eval-<time>] [--json out.json]
// Uses Node's built-in WebSocket (Node 24); fixture notes are for evaluation only.

import { readFile, writeFile } from 'node:fs/promises';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, arg, i, all) => {
    if (arg.startsWith('--')) pairs.push([arg.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]);
    return pairs;
  }, []),
);
if (typeof args.url !== 'string' || typeof args['staff-key'] !== 'string'
  || (args.office !== undefined && typeof args.office !== 'string')
  || (args.json !== undefined && typeof args.json !== 'string')) {
  console.error('usage: node scripts/eval-assist.mjs --url wss://... --staff-key KEY [--office eval-<time>] [--json out.json]');
  process.exit(2);
}
const office = args.office ?? `eval-${Date.now().toString(36)}`;
const WAIT_MS = 60_000;
const clients = [];
const patrons = [];
const report = { office, cases: [], translations: [], errors: [] };

/** Queue messages so replies arriving before next() are also available. */
function client(role) {
  const ws = new WebSocket(`${args.url}?office=${encodeURIComponent(office)}&role=${role}`);
  const inbox = [];
  const waiters = [];
  let failure = null;
  const opened = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${role} connection timed out`)), WAIT_MS);
    ws.onopen = () => { clearTimeout(timer); resolve(); };
    ws.onerror = () => { clearTimeout(timer); reject(new Error(`${role} connection refused`)); };
    ws.onclose = () => { clearTimeout(timer); reject(new Error(`${role} connection closed`)); };
  });
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    const i = waiters.findIndex((w) => w.match(msg));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
    else inbox.push(msg);
  };
  const c = {
    opened,
    close: () => ws.close(),
    next(match, label) {
      const i = inbox.findIndex(match);
      if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
      if (failure) return Promise.reject(failure);
      return new Promise((resolve, reject) => {
        const waiter = { match, resolve: (msg) => { clearTimeout(timer); resolve(msg); }, reject: (error) => { clearTimeout(timer); reject(error); } };
        const timer = setTimeout(() => {
          waiters.splice(waiters.indexOf(waiter), 1);
          reject(new Error(`timed out waiting for ${label}`));
        }, WAIT_MS);
        waiters.push(waiter);
      });
    },
    async request(msg, match, label) {
      ws.send(JSON.stringify(msg));
      return c.next((m) => m.type === 'error' || match(m), label);
    },
  };
  clients.push(c);
  void opened.then(() => {
    const disconnected = () => {
      failure = new Error(`${role} connection closed`);
      for (const waiter of waiters.splice(0)) waiter.reject(failure);
    };
    ws.onerror = disconnected;
    ws.onclose = disconnected;
  }, () => undefined);
  return c;
}

function checked(reply) {
  if (reply.type === 'error') throw new Error(reply.code);
  return reply;
}

async function measure(c, msg, match, label, passes) {
  const start = performance.now();
  try {
    const reply = await c.request(msg, match, label);
    return { reply, latencyMs: Math.round(performance.now() - start), pass: reply.type !== 'error' && passes(reply), ...(reply.type === 'error' ? { error: reply.code } : {}) };
  } catch (error) {
    return { reply: null, latencyMs: Math.round(performance.now() - start), pass: false, error: error.message };
  }
}

console.log(`Assist evaluation against ${args.url} (office ${office})`);
try {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/eval-clinic.json', import.meta.url), 'utf8'));
  const screen = client('screen');
  await screen.opened;
  const notes = checked(await screen.request({ action: 'notes', lang: 'en' }, (m) => m.type === 'notes', 'current notes'));
  const saved = checked(await screen.request({ action: 'saveNotes', text: fixture.notes, baseVersion: notes.version, staffKey: args['staff-key'] }, (m) => m.type === 'notes', 'saved notes'));
  if (saved.text !== fixture.notes || saved.version !== notes.version + 1) throw new Error('saved notes did not match');

  let patron;
  for (const [i, item] of fixture.cases.entries()) {
    if (i % 8 === 0) {
      patron = client('patron');
      await patron.opened;
      const ticket = checked(await patron.request({ action: 'join', staffKey: args['staff-key'] }, (m) => m.type === 'ticket', 'evaluation ticket'));
      patron.ticket = { ticketNo: ticket.ticketNo, secret: ticket.secret };
      patrons.push(patron);
    }
    const result = await measure(patron,
      { action: 'ask', ...patron.ticket, question: item.question, lang: item.lang },
      (m) => m.type === 'answer' && m.question === item.question, item.id,
      (reply) => {
        if (item.kind === 'answerable') return reply.found === true && typeof reply.answer === 'string' && item.expect.some((expected) => reply.answer.toLowerCase().includes(expected));
        if (item.kind === 'unanswerable') return reply.found === false;
        return reply.found === false || (typeof reply.answer === 'string' && !/\p{Number}/u.test(reply.answer));
      });
    report.cases.push({ ...item, ...result });
  }
  for (const lang of ['af', 'zu', 'st']) {
    const result = await measure(screen, { action: 'notes', lang }, (m) => m.type === 'notes', `${lang} notes`, (reply) => reply.translated === true);
    report.translations.push({ lang, ...result });
  }
} catch (error) {
  report.errors.push(error.message);
  console.error(`  FAILED  ${error.message}`);
} finally {
  for (const patron of patrons) {
    try {
      checked(await patron.request({ action: 'leave', ...patron.ticket }, (m) => m.type === 'status' && m.ticket.ticketNo === patron.ticket.ticketNo && m.ticket.status === 'left', 'evaluation ticket left'));
    } catch (error) {
      report.errors.push(`cleanup: ${error.message}`);
      console.error(`  FAILED  cleanup: ${error.message}`);
    }
  }
  for (const c of clients) c.close();
}

const results = [...report.cases, ...report.translations];
console.table(results.map((item) => ({
  case: item.id ?? `notes-${item.lang}`,
  kind: item.kind ?? 'translation',
  lang: item.lang,
  result: item.pass ? 'PASS' : item.error ?? 'FAIL',
  ms: item.latencyMs,
  reply: item.reply?.answer ?? item.reply?.text ?? '',
})));
const sorted = results.map((item) => item.latencyMs).sort((a, b) => a - b);
// Match the load script's percentile convention, across asks and translations.
const pct = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
const passed = (kind) => report.cases.filter((item) => item.kind === kind && item.pass).length;
const translated = report.translations.filter((item) => item.pass).length;
report.summary = { answerable: passed('answerable'), unanswerable: passed('unanswerable'), injection: passed('injection'), translated, p50: pct(0.5), p95: pct(0.95) };
console.log(`answerable ${report.summary.answerable}/8, unanswerable ${report.summary.unanswerable}/4, injection ${report.summary.injection}/4, translated ${translated}/3, p50 ${report.summary.p50}ms, p95 ${report.summary.p95}ms`);
if (args.json) {
  try {
    await writeFile(args.json, `${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    report.errors.push(error.message);
    console.error(`  FAILED  writing results: ${error.message}`);
  }
}
process.exitCode = report.errors.length || results.length !== 19 || results.some((item) => !item.pass) ? 1 : 0;
