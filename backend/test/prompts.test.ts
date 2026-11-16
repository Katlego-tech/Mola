import { describe, expect, it } from 'vitest';
import { askPrompt, notesPrompt, officeName, summaryPrompt } from '../src/lib/prompts';

describe('prompts', () => {
  it('puts notes and the language in the system prompt and only the question in the user message', () => {
    const prompt = askPrompt('home-affairs', 'Bring ID', 'What must I bring?', 'zu');
    expect(prompt.system).toContain('Home Affairs');
    expect(prompt.system).toContain('<notes>Bring ID</notes>');
    expect(prompt.system).toContain('Reply in isiZulu');
    expect(prompt.user).toBe('What must I bring?');
    expect(prompt.maxTokens).toBe(300);
    expect(prompt.tool.name).toBe('answer');
    for (const field of ['ticketNo', 'queueKey', 'secretHash', 'deadline', 'servedAt', 'position:']) {
      expect(JSON.stringify(prompt)).not.toContain(field);
    }
  });
  it('builds a translation with only notes as the user text', () => {
    expect(notesPrompt('Bring ID', 'af')).toEqual({ system: "Translate the user's text into Afrikaans. Keep every number, time, date, name, address and web address exactly as written. Output only the translation.", user: 'Bring ID', maxTokens: 2000 });
    expect(officeName('cape-town-office')).toBe('Cape Town Office');
  });
  it('builds a summary from computed statistics only', () => {
    const stats = { date: '2026-11-16', issued: 0, seen: 0, left: 0, missed: 0, waitingNow: 0,
      medianWaitMinutes: null, longestWaitMinutes: null, busiestHour: null, desks: [] };
    expect(summaryPrompt(stats)).toMatchObject({ user: JSON.stringify(stats), maxTokens: 400 });
    expect(summaryPrompt(stats).system).toContain('Do not calculate new figures');
  });
});
