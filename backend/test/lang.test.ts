import { expect, it } from 'vitest';
import { isLang, LANGS } from '../src/lib/lang';

it('recognises only the four own language keys', () => {
  expect(LANGS).toEqual({ en: 'English', zu: 'isiZulu', af: 'Afrikaans', st: 'Sesotho' });
  for (const lang of Object.keys(LANGS)) expect(isLang(lang)).toBe(true);
  for (const value of ['fr', 'toString', '__proto__', null, 1]) expect(isLang(value)).toBe(false);
});
