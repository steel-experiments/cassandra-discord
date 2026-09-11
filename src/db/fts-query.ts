/**
 * Safe FTS5 query parsing (Section 30.2).
 *
 * User- and model-supplied search text is untrusted: FTS5 query syntax (`" * ( )
 * : ^ - +`) can alter query structure, force expensive prefix scans, or throw
 * syntax errors. This module reduces input to Unicode word tokens and quotes each
 * as a literal phrase, so operator characters become inert and wildcard
 * expansion is bounded. Length, token, and result caps keep work bounded.
 */

export const MAX_QUERY_LENGTH = 256;
export const MAX_TOKENS = 32;
export const MAX_RESULT_LIMIT = 50;
export const DEFAULT_LIMIT = 10;

export interface ParsedFtsQuery {
  /** Safe FTS5 MATCH expression (`"tok" "tok"`), or '' when no valid tokens. */
  match: string;
  /** The cleaned exact phrase (space-joined tokens), for phrase-match bonuses. */
  phrase: string;
  /** The cleaned tokens. */
  terms: string[];
}

/**
 * Parse raw search text into a safe MATCH expression plus the tokens/phrase used
 * for host-side ranking (Section 30.1). Returns `match: ''` when nothing valid
 * remains; callers skip the search rather than issuing an empty MATCH (FTS5
 * rejects empty).
 */
export function parseFtsQuery(raw: string): ParsedFtsQuery {
  const cleaned = (raw ?? '')
    .slice(0, MAX_QUERY_LENGTH)
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  if (!cleaned) return { match: '', phrase: '', terms: [] };
  const terms = cleaned.split(/\s+/).slice(0, MAX_TOKENS);
  return {
    match: terms.map((t) => `"${t}"`).join(' '),
    phrase: terms.join(' '),
    terms,
  };
}

/**
 * Backwards-compatible sanitized MATCH string. Equivalent to `parseFtsQuery(raw).match`.
 * Prefer {@link parseFtsQuery} when the phrase/tokens are needed for ranking.
 */
export function sanitizeFtsQuery(raw: string): string {
  return parseFtsQuery(raw).match;
}
