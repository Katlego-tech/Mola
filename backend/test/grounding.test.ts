import { describe, expect, it } from 'vitest';
import { groundedNumbers, numbersIn, sameNumbers } from '../src/lib/grounding';

describe('number grounding', () => {
  it('extracts digits, time components and decimal separators', () => {
    expect(numbersIn('Bring 3 copies at 08:30; cost 4,5 or 4.5.')).toEqual([3, 8, 30, 4.5, 4.5]);
    expect(numbersIn('No numbers')).toEqual([]);
  });
  it('accepts numbers from either notes or question and refuses new ones', () => {
    expect(groundedNumbers('Bring 2 copies', ['Bring copies', 'May I bring 2?'])).toBe(true);
    expect(groundedNumbers('Bring 3 copies', ['Bring copies', 'May I bring 2?'])).toBe(false);
  });
  it('compares counts as well as values when translating', () => {
    expect(sameNumbers('08:30 and 4,5', '4.5 at 8:30')).toBe(true);
    expect(sameNumbers('2 copies, 2 photos', '2 copies')).toBe(false);
    expect(sameNumbers('2 copies', '3 copies')).toBe(false);
  });
});
