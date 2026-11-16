import type { OfficeSnapshot } from './model';

export interface DayStats {
  date: string; issued: number; seen: number; left: number; missed: number; waitingNow: number;
  medianWaitMinutes: number | null; longestWaitMinutes: number | null;
  busiestHour: { hour: number; issued: number } | null;
  desks: { desk: string; seen: number }[];
}

export function dayStats(snapshot: OfficeSnapshot, nowMs: number, timeZone: string): DayStats {
  const format = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  });
  function local(ms: number) {
    const parts = format.formatToParts(ms);
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(value => value.type === type)?.value;
    return { date: `${part('year')}-${part('month')}-${part('day')}`, hour: Number(part('hour')) };
  }
  const date = local(nowMs).date;
  const tickets = snapshot.tickets.filter(ticket => ticket.expiresAt > nowMs / 1000
    && local(Date.parse(ticket.createdAt)).date === date);
  const seen = tickets.filter(ticket => (ticket.status === 'serving' || ticket.status === 'done') && ticket.servedAt !== undefined);
  const waits = seen.map(ticket => Math.floor((Date.parse(ticket.servedAt as string) - Date.parse(ticket.createdAt)) / 60_000)).sort((a, b) => a - b);
  const hours = new Map<number, number>();
  const desks = new Map<string, number>();
  for (const ticket of tickets) {
    const hour = local(Date.parse(ticket.createdAt)).hour;
    hours.set(hour, (hours.get(hour) ?? 0) + 1);
  }
  for (const ticket of seen) {
    if (ticket.desk !== undefined) desks.set(ticket.desk, (desks.get(ticket.desk) ?? 0) + 1);
  }
  const busiest = [...hours].sort(([a, n], [b, m]) => m - n || a - b)[0];
  return {
    date, issued: tickets.length, seen: seen.length,
    left: tickets.filter(ticket => ticket.status === 'left').length,
    missed: tickets.filter(ticket => ticket.status === 'no_show').length,
    waitingNow: tickets.filter(ticket => ticket.status === 'waiting' || ticket.status === 'called').length,
    medianWaitMinutes: waits.length ? waits[Math.floor((waits.length - 1) / 2)] as number : null,
    longestWaitMinutes: waits.length ? waits[waits.length - 1] as number : null,
    busiestHour: busiest ? { hour: busiest[0], issued: busiest[1] } : null,
    desks: [...desks].map(([desk, count]) => ({ desk, seen: count }))
      .sort((a, b) => b.seen - a.seen || a.desk.localeCompare(b.desk)),
  };
}
