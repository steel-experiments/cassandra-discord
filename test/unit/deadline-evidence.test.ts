import { describe, it, expect } from 'vitest';
import {
  DEADLINE_PARSER_VERSION,
  deadlineWindowIsRelevant,
  findCandidateDeadlineExpressions,
  parseDeadlineExpression,
  parseQuotedDeadline,
  proposedAtAgrees,
} from '../../src/memory/deadline-evidence.js';
import { DEFAULT_ATTENTION_WINDOW_MS } from '../../src/memory/attention.js';

const UTC = 'UTC';
const ZAGREB = 'Europe/Zagreb';
const WINDOW = DEFAULT_ATTENTION_WINDOW_MS;
/** Monday, 14 September 2026, 12:00 UTC — 14:00 in Zagreb (CEST). */
const SOURCE = Date.UTC(2026, 8, 14, 12, 0, 0);

function endOfDayUtc(year: number, month: number, day: number): number {
  return Date.UTC(year, month - 1, day, 23, 59, 59, 999);
}

describe('deadline expression grammar', () => {
  it('parses an ISO date as the end of the local day', () => {
    const result = parseDeadlineExpression('2026-09-18', { sourceAtMs: SOURCE, timezone: ZAGREB });
    expect(result).toEqual({
      ok: true,
      deadline: {
        // CEST (UTC+2) local midnight is 21:59:59.999Z.
        dueAtMs: Date.UTC(2026, 8, 18, 21, 59, 59, 999),
        parserVersion: DEADLINE_PARSER_VERSION,
        basis: 'iso_date',
      },
    });
  });

  it('parses an ISO date in UTC without an offset shift', () => {
    const result = parseDeadlineExpression('2026-09-18', { sourceAtMs: SOURCE, timezone: UTC });
    expect(result.ok && result.deadline.dueAtMs).toBe(endOfDayUtc(2026, 9, 18));
  });

  it('parses full day/month/year forms in both orders', () => {
    const a = parseDeadlineExpression('18 September 2026', { sourceAtMs: SOURCE, timezone: UTC });
    const b = parseDeadlineExpression('September 18, 2026', { sourceAtMs: SOURCE, timezone: UTC });
    const c = parseDeadlineExpression('September 18 2026', { sourceAtMs: SOURCE, timezone: UTC });
    expect(a.ok && a.deadline.dueAtMs).toBe(endOfDayUtc(2026, 9, 18));
    expect(b.ok && b.deadline.dueAtMs).toBe(endOfDayUtc(2026, 9, 18));
    expect(c.ok && c.deadline.dueAtMs).toBe(endOfDayUtc(2026, 9, 18));
  });

  it('uses the exact instant for ISO timestamps with an explicit offset', () => {
    const expected = Date.UTC(2026, 8, 18, 15, 30, 0);
    for (const expression of ['2026-09-18T15:30:00Z', '2026-09-18 15:30:00Z', '2026-09-18T17:30:00+02:00']) {
      const result = parseDeadlineExpression(expression, { sourceAtMs: SOURCE, timezone: ZAGREB });
      expect(result.ok && result.deadline.dueAtMs).toBe(expected);
      expect(result.ok && result.deadline.basis).toBe('iso_timestamp');
    }
  });

  it('resolves today and tomorrow against the source message local date', () => {
    const today = parseDeadlineExpression('today', { sourceAtMs: SOURCE, timezone: ZAGREB });
    const tomorrow = parseDeadlineExpression('tomorrow', { sourceAtMs: SOURCE, timezone: ZAGREB });
    expect(today.ok && today.deadline.dueAtMs).toBe(Date.UTC(2026, 8, 14, 21, 59, 59, 999));
    expect(tomorrow.ok && tomorrow.deadline.dueAtMs).toBe(Date.UTC(2026, 8, 15, 21, 59, 59, 999));
  });

  it('resolves an unqualified weekday to the first occurrence on or after the source date', () => {
    // Source is Monday 14 September; Friday is 18 September.
    const friday = parseDeadlineExpression('Friday', { sourceAtMs: SOURCE, timezone: UTC });
    expect(friday.ok && friday.deadline.dueAtMs).toBe(endOfDayUtc(2026, 9, 18));
    // Monday on a Monday is the same day.
    const monday = parseDeadlineExpression('Monday', { sourceAtMs: SOURCE, timezone: UTC });
    expect(monday.ok && monday.deadline.dueAtMs).toBe(endOfDayUtc(2026, 9, 14));
  });

  it('handles the DST transition day without shifting the local day', () => {
    // DST in Zagreb ends on Sunday 25 October 2026 at 03:00 CEST; the evening
    // is CET (UTC+1), so the local day ends at 22:59:59.999Z.
    const result = parseDeadlineExpression('2026-10-25', { sourceAtMs: SOURCE, timezone: ZAGREB });
    expect(result.ok && result.deadline.dueAtMs).toBe(Date.UTC(2026, 9, 25, 22, 59, 59, 999));
    const winter = parseDeadlineExpression('2026-01-15', { sourceAtMs: SOURCE, timezone: ZAGREB });
    expect(winter.ok && winter.deadline.dueAtMs).toBe(Date.UTC(2026, 0, 15, 22, 59, 59, 999));
  });

  it('rejects ambiguous numeric forms, relative qualifiers, missing years, and impossible dates', () => {
    const rejects = [
      '03/04/2026',
      '2026/09/18',
      'next Friday',
      'this week',
      'end of week',
      'end of month',
      'Friday next week',
      '18 September',
      'September 18',
      'soon',
      'in two weeks',
      'Q3',
      '30 February 2026',
      '2026-02-29',
      '2026-13-01',
      '2026-09-31',
      '2026-02-30T12:00:00Z',
      '2026-09-31T12:00:00+02:00',
      'Sept 18 2026',
    ];
    for (const expression of rejects) {
      const result = parseDeadlineExpression(expression, { sourceAtMs: SOURCE, timezone: UTC });
      expect(result.ok, expression).toBe(false);
      if (!result.ok) {
        expect(['unsupported_expression', 'impossible_date', 'ambiguous_expression']).toContain(result.reason);
      }
    }
  });

  it('rejects an ISO-like timestamp without an explicit offset', () => {
    // Without Z or ±HH:MM the instant is timezone-ambiguous, so it is not
    // deadline authority under the conservative grammar.
    const result = parseDeadlineExpression('2026-09-18T15:30:00', { sourceAtMs: SOURCE, timezone: UTC });
    expect(result.ok).toBe(false);
  });
});

describe('proposedAt agreement', () => {
  it('requires exact equality for offset timestamps', () => {
    const parsed = parseDeadlineExpression('2026-09-18T15:30:00Z', { sourceAtMs: SOURCE, timezone: UTC });
    if (!parsed.ok) throw new Error('expected parse success');
    expect(proposedAtAgrees(parsed.deadline.dueAtMs, parsed.deadline, UTC)).toBe(true);
    expect(proposedAtAgrees(parsed.deadline.dueAtMs + 1, parsed.deadline, UTC)).toBe(false);
  });

  it('accepts any instant inside the same local day for date-only bases', () => {
    const parsed = parseDeadlineExpression('18 September 2026', { sourceAtMs: SOURCE, timezone: ZAGREB });
    if (!parsed.ok) throw new Error('expected parse success');
    const morning = Date.UTC(2026, 8, 18, 5, 0, 0);
    const nextDay = Date.UTC(2026, 8, 19, 5, 0, 0);
    expect(proposedAtAgrees(morning, parsed.deadline, ZAGREB)).toBe(true);
    expect(proposedAtAgrees(nextDay, parsed.deadline, ZAGREB)).toBe(false);
  });
});

describe('deadline source binding', () => {
  function parseQuote(content: string, quote: string, expression: string) {
    const quoteStart = content.indexOf(quote);
    if (quoteStart < 0) throw new Error('test quote must exist');
    return parseQuotedDeadline(expression, {
      content, quoteStart, quoteEnd: quoteStart + quote.length,
    }, { sourceAtMs: SOURCE, timezone: UTC });
  }

  it('requires the selected date inside the quoted commitment', () => {
    const content = 'The report is promised by 18 September 2026. Customer demo is on 30 September 2026.';
    const quote = 'The report is promised by 18 September 2026';
    expect(parseQuote(content, quote, '30 September 2026').ok).toBe(false);
    const accepted = parseQuote(content, quote, '18 September 2026');
    expect(accepted.ok && accepted.deadline.dueAtMs).toBe(endOfDayUtc(2026, 9, 18));
  });

  it('rejects conflicting dates in the same quote', () => {
    const quote = 'The report is promised by 18 September 2026 or 30 September 2026.';
    expect(parseQuote(quote, quote, '18 September 2026')).toEqual({ ok: false, reason: 'ambiguous_expression' });
  });

  it('checks conflicts beyond the candidate prescreen cap', () => {
    const quote = 'Ship by 2026-09-18, 18 September 2026, September 18 2026, September 18, 2026, Friday, or 2026-09-30.';
    expect(findCandidateDeadlineExpressions(quote)).toHaveLength(5);
    expect(parseQuote(quote, quote, '2026-09-18')).toEqual({ ok: false, reason: 'ambiguous_expression' });
  });

  it.each([
    'next Friday', 'Next Friday', 'NEXT Friday', 'next  Friday', 'next\tFriday',
    'next\nFriday', 'this Friday', 'last Friday', 'every Friday', 'coming Friday',
    'Friday next week', 'Friday  next week', 'Friday of next week', 'Friday in the following week',
    'Friday after next',
  ])('does not shorten the qualified phrase %j to an unqualified weekday', (phrase) => {
    const content = `The report is promised by ${phrase}.`;
    expect(parseQuote(content, content, 'Friday').ok).toBe(false);
    // A model cannot hide the qualifier by narrowing its quote to just the weekday.
    expect(parseQuote(content, 'Friday', 'Friday').ok).toBe(false);
  });

  it('keeps ordinary unqualified weekdays and exact offset timestamps usable', () => {
    for (const expression of ['Friday', '2026-09-18T15:30:00Z', '2026-09-18 17:30:00+02:00']) {
      const content = `The report is promised by ${expression}.`;
      expect(parseQuote(content, content, expression).ok).toBe(true);
    }
    expect(parseQuote('The report is promised by Friday.', 'Friday', 'Friday').ok).toBe(true);
  });
});

describe('window relevance and candidate prescreen', () => {
  it('treats a deadline as relevant while its window is current or future', () => {
    const future = parseDeadlineExpression('2026-10-30', { sourceAtMs: SOURCE, timezone: UTC });
    const past = parseDeadlineExpression('2026-09-01', { sourceAtMs: SOURCE, timezone: UTC });
    if (!future.ok || !past.ok) throw new Error('expected parse success');
    expect(deadlineWindowIsRelevant(future.deadline, SOURCE, WINDOW)).toBe(true);
    expect(deadlineWindowIsRelevant(past.deadline, SOURCE, WINDOW)).toBe(false);
  });

  it('finds distinct candidate expressions and caps the result', () => {
    const content = 'ship by 2026-09-18, or maybe 18 September 2026. Friday works. 03/04 is ambiguous. today or tomorrow.';
    const found = findCandidateDeadlineExpressions(content);
    expect(found).toEqual(['2026-09-18', '18 September 2026', 'Friday', 'today', 'tomorrow']);
    const flood = Array.from({ length: 12 }, (_, i) => `note ${i}: due 2026-10-0${(i % 9) + 1}`).join(' ');
    expect(findCandidateDeadlineExpressions(flood)).toHaveLength(5);
  });

  it('prescreens whole explicit timestamps without splitting off their date', () => {
    expect(findCandidateDeadlineExpressions('Ship by 2026-09-18T15:30:00Z or 2026-09-18 17:30:00+02:00.'))
      .toEqual(['2026-09-18T15:30:00Z', '2026-09-18 17:30:00+02:00']);
  });
});
