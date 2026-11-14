import { describe, expect, it } from 'vitest';
import { aheadLabel, mmss, officeName, ordinal } from '../src/lib/format';

describe('officeName', () => {
  it('turns an office id into a display name', () => {
    expect(officeName('soweto-clinic')).toBe('Soweto Clinic');
    expect(officeName('demo')).toBe('Demo');
    expect(officeName('wits-financial-aid')).toBe('Wits Financial Aid');
  });

  it('keeps digits and ignores doubled hyphens', () => {
    expect(officeName('home-affairs--2')).toBe('Home Affairs 2');
  });
});

describe('ordinal', () => {
  it.each([
    [1, '1st'], [2, '2nd'], [3, '3rd'], [4, '4th'],
    [11, '11th'], [12, '12th'], [13, '13th'],
    [21, '21st'], [22, '22nd'], [23, '23rd'],
    [101, '101st'], [111, '111th'], [112, '112th'],
  ])('%i -> %s', (n, expected) => {
    expect(ordinal(n)).toBe(expected);
  });
});

describe('mmss', () => {
  it.each([
    [0, '0:00'], [59_000, '0:59'], [60_000, '1:00'], [102_000, '1:42'], [600_000, '10:00'],
  ])('%i ms -> %s', (ms, expected) => {
    expect(mmss(ms)).toBe(expected);
  });

  it('rounds a partial second up, so it never shows 0:00 while time is left', () => {
    expect(mmss(400)).toBe('0:01');
    expect(mmss(59_500)).toBe('1:00');
  });

  it('shows 0:00 once time has run out', () => {
    expect(mmss(-1_500)).toBe('0:00');
  });
});

describe('aheadLabel', () => {
  it('names the people ahead of a waiting position', () => {
    expect(aheadLabel(1)).toBe("You're next");
    expect(aheadLabel(2)).toBe('1 person ahead');
    expect(aheadLabel(5)).toBe('4 people ahead');
  });

  it('refuses a position that cannot come from the server', () => {
    expect(() => aheadLabel(0)).toThrow(RangeError);
    expect(() => aheadLabel(2.5)).toThrow(RangeError);
  });
});
