export type Lang = 'en' | 'zu' | 'af' | 'st';
export const LANGS: Readonly<Record<Lang, string>> = { en: 'English', zu: 'isiZulu', af: 'Afrikaans', st: 'Sesotho' };
export function isLang(value: unknown): value is Lang {
  return typeof value === 'string' && Object.hasOwn(LANGS, value);
}
