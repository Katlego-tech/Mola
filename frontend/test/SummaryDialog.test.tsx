import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ServerMessage } from '../src/lib/messages';
import { SummaryDialog } from '../src/screen/SummaryDialog';

afterEach(cleanup);
const summary: Extract<ServerMessage, { type: 'summary' }> = {
  type: 'summary', text: 'The office saw 51 people.',
  stats: {
    date: '2026-11-16', issued: 64, seen: 51, left: 6, missed: 3, waitingNow: 4,
    medianWaitMinutes: 38, longestWaitMinutes: 97, busiestHour: { hour: 9, issued: 14 },
    desks: [{ desk: 'Desk 1', seen: 18 }, { desk: 'Desk 2', seen: 17 }, { desk: 'Desk 3', seen: 16 }],
  },
};

describe('day summary', () => {
  it('renders every server tile and only numbers from the fixture or its hour bounds', () => {
    render(<SummaryDialog officeId="soweto-clinic" summary={summary} onClose={() => undefined} />);
    expect(screen.getByText('Today at Soweto Clinic')).toBeTruthy();
    expect(screen.getByText('16 November 2026')).toBeTruthy();
    for (const label of ['Tickets issued', 'Seen', 'Left', 'Missed', 'Still waiting', 'Median wait', 'Longest wait', 'Busiest hour', 'Seen per desk', 'Summary by Amazon Nova']) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    for (const value of ['64', '51', '6', '3', '4', '09:00', 'to 10:00', '18', '17', '16']) expect(screen.getByText(value)).toBeTruthy();
    for (const value of ['38 min', '97 min']) expect(screen.getByText((_text, element) => element?.tagName === 'STRONG' && element.textContent === value)).toBeTruthy();
    expect(screen.getByText(summary.text as string)).toBeTruthy();
    const allowed = new Set((JSON.stringify(summary).match(/\d+/g) ?? []).map(Number).concat([0, 10]));
    const walker = document.createTreeWalker(screen.getByRole('dialog'), NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      for (const n of node.textContent?.match(/\d+/g) ?? []) expect(allowed.has(Number(n))).toBe(true);
    }
  });

  it.each([0, 2])('omits absent tiles and shows the null summary copy for %i issued tickets', (issued) => {
    render(<SummaryDialog officeId="clinic" summary={{ ...summary, text: null, stats: { ...summary.stats, issued, medianWaitMinutes: null, longestWaitMinutes: null, busiestHour: null, desks: [] } }} onClose={() => undefined} />);
    for (const label of ['Median wait', 'Longest wait', 'Busiest hour']) expect(screen.queryByText(label)).toBeNull();
    expect(screen.getByText(issued === 0 ? 'No tickets yet today.' : "The written summary isn't available right now. The numbers above are complete.")).toBeTruthy();
  });
});
