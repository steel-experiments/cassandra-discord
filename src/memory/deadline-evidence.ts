// ABOUTME: Deterministic parser for explicit human deadline expressions and a
// ABOUTME: cheap prescreen that finds candidate dates in source text (Section 12.7).
import {
  deadlineWindow,
  windowContains,
} from './attention.js';

/** Bumped whenever the accepted grammar or resolution rules change. */
export const DEADLINE_PARSER_VERSION = 'deadline-v2';

/** Upper bound on candidate expressions extracted from one message. */
export const MAX_CANDIDATE_EXPRESSIONS = 5;

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

const WEEKDAYS = [
  'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday',
];

export type DeadlineParseBasis =
  | 'iso_date'
  | 'iso_timestamp'
  | 'day_month_year'
  | 'relative_word'
  | 'weekday';

export interface ParsedDeadline {
  /** Due instant: exact for timestamps, end of the local day for date-only forms. */
  dueAtMs: number;
  parserVersion: string;
  basis: DeadlineParseBasis;
}

export type DeadlineParseResult =
  | { ok: true; deadline: ParsedDeadline }
  | { ok: false; reason: 'unsupported_expression' | 'impossible_date' | 'ambiguous_expression' };

// ---------- timezone helpers (no date library; Intl only) ----------

/** Offset from UTC, in milliseconds, of `tz` at the given instant. */
function tzOffsetMs(instantMs: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(instantMs));
  const get = (type: string): number => {
    const part = parts.find((p) => p.type === type);
    if (!part) throw new Error(`timezone formatting failed for ${tz}`);
    return Number(part.value);
  };
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  return asUtc - Math.floor(instantMs / 1000) * 1000;
}

/** Calendar date of an instant in `tz`. */
function localDateParts(
  instantMs: number,
  tz: string,
): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(instantMs));
  const get = (type: string): number => Number(parts.find((p) => p.type === type)!.value);
  return { year: get('year'), month: get('month'), day: get('day') };
}

/**
 * UTC instant of 23:59:59.999 on the given local calendar date. Two offset
 * passes converge across a DST transition between the guess and the answer.
 */
function endOfLocalDayUtcMs(
  year: number,
  month: number,
  day: number,
  tz: string,
): number {
  const targetLocal = Date.UTC(year, month - 1, day, 23, 59, 59, 999);
  let guess = targetLocal;
  for (let pass = 0; pass < 3; pass += 1) {
    guess = targetLocal - tzOffsetMs(guess, tz);
  }
  return guess;
}

/** UTC instant of 00:00:00.000 on the given local calendar date. */
function startOfLocalDayUtcMs(
  year: number,
  month: number,
  day: number,
  tz: string,
): number {
  const targetLocal = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
  let guess = targetLocal;
  for (let pass = 0; pass < 3; pass += 1) {
    guess = targetLocal - tzOffsetMs(guess, tz);
  }
  return guess;
}

// ---------- grammar ----------

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_TIMESTAMP_RE =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})$/;
const DAY_MONTH_YEAR_RE = /^(\d{1,2}) ([A-Za-z]+) (\d{4})$/;
const MONTH_DAY_YEAR_RE = /^([A-Za-z]+) (\d{1,2}),? (\d{4})$/;

function isImpossibleDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12) return true;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const lengths = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day < 1 || day > lengths[month - 1]!;
}

export interface DeadlineParseContext {
  /** Source message creation time; relative forms resolve against its local date. */
  sourceAtMs: number;
  /** Organization timezone captured when authority is accepted. */
  timezone: string;
}

/**
 * Parse one exact date expression under the documented grammar:
 *
 * - `YYYY-MM-DD`, or an ISO timestamp with an explicit `Z`/`±HH:MM` offset;
 * - a full day/month/year form such as `18 September 2026` or
 *   `September 18, 2026`;
 * - `today`, `tomorrow`, or an unqualified weekday — the first occurrence on
 *   or after the source message's local date.
 *
 * Date-only forms fall due at the end of that local day; offset timestamps
 * use their exact instant. Ambiguous numeric forms (`03/04/2026`), `next
 * Friday`, `end of week`, missing-year month/day forms (`18 September`), and
 * anything else are rejected: a conservative omission suppresses only the
 * deadline exception, never the memory or a fresh-message intervention.
 */
export function parseDeadlineExpression(
  expression: string,
  context: DeadlineParseContext,
): DeadlineParseResult {
  const raw = expression.trim();

  if (ISO_TIMESTAMP_RE.test(raw)) {
    const [year, month, day] = raw.slice(0, 10).split('-').map(Number);
    if (isImpossibleDate(year!, month!, day!)) {
      return { ok: false, reason: 'impossible_date' };
    }
    const dueAtMs = Date.parse(raw.replace(' ', 'T'));
    if (!Number.isFinite(dueAtMs)) {
      return { ok: false, reason: 'impossible_date' };
    }
    return { ok: true, deadline: { dueAtMs, parserVersion: DEADLINE_PARSER_VERSION, basis: 'iso_timestamp' } };
  }

  if (ISO_DATE_RE.test(raw)) {
    const [, y, m, d] = raw.match(ISO_DATE_RE)!;
    const year = Number(y), month = Number(m), day = Number(d);
    if (isImpossibleDate(year, month, day)) {
      return { ok: false, reason: 'impossible_date' };
    }
    return {
      ok: true,
      deadline: {
        dueAtMs: endOfLocalDayUtcMs(year, month, day, context.timezone),
        parserVersion: DEADLINE_PARSER_VERSION,
        basis: 'iso_date',
      },
    };
  }

  const dayMonthYear = raw.match(DAY_MONTH_YEAR_RE);
  if (dayMonthYear) {
    const day = Number(dayMonthYear[1]);
    const month = MONTHS.indexOf(dayMonthYear[2]!.toLowerCase());
    const year = Number(dayMonthYear[3]);
    if (month === -1 || isImpossibleDate(year, month + 1, day)) {
      return month === -1
        ? { ok: false, reason: 'unsupported_expression' }
        : { ok: false, reason: 'impossible_date' };
    }
    return {
      ok: true,
      deadline: {
        dueAtMs: endOfLocalDayUtcMs(year, month + 1, day, context.timezone),
        parserVersion: DEADLINE_PARSER_VERSION,
        basis: 'day_month_year',
      },
    };
  }

  const monthDayYear = raw.match(MONTH_DAY_YEAR_RE);
  if (monthDayYear) {
    const month = MONTHS.indexOf(monthDayYear[1]!.toLowerCase());
    const day = Number(monthDayYear[2]);
    const year = Number(monthDayYear[3]);
    if (month === -1 || isImpossibleDate(year, month + 1, day)) {
      return month === -1
        ? { ok: false, reason: 'unsupported_expression' }
        : { ok: false, reason: 'impossible_date' };
    }
    return {
      ok: true,
      deadline: {
        dueAtMs: endOfLocalDayUtcMs(year, month + 1, day, context.timezone),
        parserVersion: DEADLINE_PARSER_VERSION,
        basis: 'day_month_year',
      },
    };
  }

  const lower = raw.toLowerCase();
  const source = localDateParts(context.sourceAtMs, context.timezone);
  if (lower === 'today' || lower === 'tomorrow') {
    const base = Date.UTC(source.year, source.month - 1, source.day);
    const offsetDays = lower === 'tomorrow' ? 1 : 0;
    const target = new Date(base + offsetDays * 86_400_000);
    return {
      ok: true,
      deadline: {
        dueAtMs: endOfLocalDayUtcMs(
          target.getUTCFullYear(), target.getUTCMonth() + 1, target.getUTCDate(),
          context.timezone,
        ),
        parserVersion: DEADLINE_PARSER_VERSION,
        basis: 'relative_word',
      },
    };
  }

  const weekday = WEEKDAYS.indexOf(lower);
  if (weekday !== -1) {
    const base = new Date(Date.UTC(source.year, source.month - 1, source.day));
    const daysAhead = (weekday - base.getUTCDay() + 7) % 7;
    const target = new Date(base.getTime() + daysAhead * 86_400_000);
    return {
      ok: true,
      deadline: {
        dueAtMs: endOfLocalDayUtcMs(
          target.getUTCFullYear(), target.getUTCMonth() + 1, target.getUTCDate(),
          context.timezone,
        ),
        parserVersion: DEADLINE_PARSER_VERSION,
        basis: 'weekday',
      },
    };
  }

  // Ambiguous or unsupported: numeric d/m or m/d forms, "next Friday",
  // "end of week", missing-year forms, and everything else.
  return { ok: false, reason: 'ambiguous_expression' };
}

/**
 * Whether a model-proposed timestamp agrees with the parsed deadline. An exact
 * offset timestamp must match to the millisecond; a date-only basis accepts
 * any proposed instant inside the same local calendar day.
 */
export function proposedAtAgrees(
  proposedAtMs: number,
  deadline: ParsedDeadline,
  timezone: string,
): boolean {
  if (deadline.basis === 'iso_timestamp') {
    return proposedAtMs === deadline.dueAtMs;
  }
  const deadlineDay = localDateParts(deadline.dueAtMs, timezone);
  const start = startOfLocalDayUtcMs(deadlineDay.year, deadlineDay.month, deadlineDay.day, timezone);
  const end = endOfLocalDayUtcMs(deadlineDay.year, deadlineDay.month, deadlineDay.day, timezone);
  return proposedAtMs >= start && proposedAtMs <= end;
}

/** Whether a parsed deadline's window is still current or in the future. */
export function deadlineWindowIsRelevant(
  deadline: ParsedDeadline,
  now: number,
  windowMs: number,
): boolean {
  const window = deadlineWindow(deadline.dueAtMs, windowMs);
  return windowContains(window, now) || now < window.fromMs;
}

// ---------- candidate prescreen ----------

const CANDIDATE_RE =
  /\b(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})|\d{4}-\d{2}-\d{2}|\d{1,2} (?:january|february|march|april|may|june|july|august|september|october|november|december) \d{4}|(?:january|february|march|april|may|june|july|august|september|october|november|december) \d{1,2},? \d{4}|today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi;

function allDeadlineExpressions(content: string): string[] {
  const found: string[] = [];
  for (const match of content.matchAll(CANDIDATE_RE)) {
    const expression = match[1]!;
    if (!found.some((existing) => existing.toLowerCase() === expression.toLowerCase())) {
      found.push(expression);
    }
  }
  return found;
}

/**
 * Bind the date to the exact quoted commitment, while checking qualifiers in
 * the surrounding source too. Quoting only "Friday" cannot hide "next Friday".
 */
export function deadlineExpressionIsBoundToQuote(
  content: string,
  quoteStart: number,
  quoteEnd: number,
  expression: string,
): boolean {
  const value = expression.trim();
  if (!value || quoteStart < 0 || quoteEnd > content.length || quoteStart >= quoteEnd) return false;
  const quoted = content.slice(quoteStart, quoteEnd);
  const relative = WEEKDAYS.includes(value.toLowerCase())
    || value.toLowerCase() === 'today' || value.toLowerCase() === 'tomorrow';
  let offset = quoted.indexOf(value);
  while (offset !== -1) {
    const start = quoteStart + offset;
    const end = start + value.length;
    const before = content.slice(0, start);
    const after = content.slice(end);
    const bounded = !/[\p{L}\p{N}_-]$/u.test(before) && !/^[\p{L}\p{N}_-]/u.test(after);
    const prefixQualified = /\b(?:next|this|last|every|each|any|following|coming|previous|same|another)\s+$/iu.test(before);
    const suffixQualified = /^\s+(?:(?:next|this|last|every|each|any|following|coming|previous)\s+(?:week|month|year)|(?:of|in)\s+(?:the\s+)?(?:next|this|last|following|coming|previous)\s+(?:week|month|year)|after\s+next)\b/iu.test(after);
    if (bounded && (!relative || (!prefixQualified && !suffixQualified))) return true;
    offset = quoted.indexOf(value, offset + value.length);
  }
  return false;
}

/** Parse the selected date and reject conflicting expressions in the bounded quote. */
export function parseQuotedDeadline(
  expression: string,
  source: { content: string; quoteStart: number; quoteEnd: number },
  context: DeadlineParseContext,
): DeadlineParseResult {
  if (!deadlineExpressionIsBoundToQuote(source.content, source.quoteStart, source.quoteEnd, expression)) {
    return { ok: false, reason: 'unsupported_expression' };
  }
  const selected = parseDeadlineExpression(expression, context);
  if (!selected.ok) return selected;
  const dates = new Set([selected.deadline.dueAtMs]);
  for (const candidate of allDeadlineExpressions(source.content.slice(source.quoteStart, source.quoteEnd))) {
    const parsed = parseDeadlineExpression(candidate, context);
    if (parsed.ok) dates.add(parsed.deadline.dueAtMs);
  }
  return dates.size === 1 ? selected : { ok: false, reason: 'ambiguous_expression' };
}

/**
 * Cheap text prescreen for registration candidate detection: the distinct
 * expressions in `content` that match the supported grammar's shape. A
 * candidate is never deadline authority; the scoped registration run must
 * validate the commitment through the typed contract.
 */
export function findCandidateDeadlineExpressions(content: string): string[] {
  return allDeadlineExpressions(content).slice(0, MAX_CANDIDATE_EXPRESSIONS);
}
