export const LANGS = { en: 'English', zu: 'isiZulu', af: 'Afrikaans', st: 'Sesotho' } as const;
export type Lang = keyof typeof LANGS;
