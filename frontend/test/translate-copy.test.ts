import { describe, expect, it } from 'vitest';

import { checkCatalog } from '../../scripts/translate-copy.mjs';

describe('copy translation checks', () => {
  const source = { ticket: 'Ticket {no}', warning: 'Back {places} places. 08:30, 4,5 and 4,5.' };
  it('accepts reordered placeholders and numbers', () => {
    expect(checkCatalog(source, { ticket: '{no} Ticket', warning: '4,5 08:30 4,5 {places}' })).toBe(true);
  });
  it.each([
    null, [], {},
    { ticket: 'Ticket {n}', warning: source.warning },
    { ...source, extra: 'unexpected' },
    { ...source, ticket: 12 },
    { ...source, warning: 'Back {places} places. 08:30, 4,5.' },
    { ...source, warning: 'Back {places} places. 08:31, 4,5 and 4,5.' },
  ])('rejects missing keys, changed placeholders, malformed values and changed numbers: %j', (translation) => {
    expect(checkCatalog(source, translation)).toBe(false);
  });
});
