import { describe, it, expect } from 'vitest';
import {
  parseFtsQuery,
  sanitizeFtsQuery,
  MAX_QUERY_LENGTH,
  MAX_TOKENS,
} from '../../src/db/fts-query.js';

describe('fts-query parsing', () => {
  it('quotes each word token as a literal phrase and exposes the phrase', () => {
    expect(parseFtsQuery('onboarding trial')).toEqual({
      match: '"onboarding" "trial"',
      phrase: 'onboarding trial',
      terms: ['onboarding', 'trial'],
    });
  });

  it('strips FTS5 operator characters so they cannot alter query structure', () => {
    // `*` is a prefix wildcard, `"` delimits phrases, `:` scopes columns,
    // `(` `)` group, `-`/`+` are boolean ops — all reduced to separators.
    expect(parseFtsQuery('on*"board:foo)')).toEqual({
      match: '"on" "board" "foo"',
      phrase: 'on board foo',
      terms: ['on', 'board', 'foo'],
    });
  });

  it('caps query length before tokenizing', () => {
    const huge = 'a'.repeat(MAX_QUERY_LENGTH + 50);
    const parsed = parseFtsQuery(huge);
    // Only the first MAX_QUERY_LENGTH chars are considered → one token.
    expect(parsed.terms).toEqual(['a'.repeat(MAX_QUERY_LENGTH)]);
  });

  it('caps the number of tokens', () => {
    const many = Array.from({ length: MAX_TOKENS + 5 }, (_, i) => `t${i}`).join(' ');
    expect(parseFtsQuery(many).terms.length).toBe(MAX_TOKENS);
  });

  it('returns empty match for blank, control-only, or operator-only input', () => {
    for (const bad of ['', '  ', '"""', '***', '(:)', '\n\t']) {
      expect(parseFtsQuery(bad)).toEqual({ match: '', phrase: '', terms: [] });
      expect(sanitizeFtsQuery(bad)).toBe('');
    }
  });

  it('preserves unicode word characters (diacritics kept as letters)', () => {
    // The tokenizer removes non-word chars but keeps letters/digits, including
    // unicode letters. Only whitespace/non-word separates.
    expect(parseFtsQuery('café résumé').terms).toEqual(['café', 'résumé']);
  });

  it('sanitizeFtsQuery matches parseFtsQuery(...).match', () => {
    expect(sanitizeFtsQuery('hello world')).toBe(parseFtsQuery('hello world').match);
  });
});
