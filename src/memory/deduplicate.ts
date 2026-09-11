import { type DatabaseSync } from '../db/database.js';
import type { SQLOutputValue } from 'node:sqlite';
import { prepareCached } from '../db/repositories/util.js';
import { sanitizeFtsQuery, type RetrievalGrant } from '../db/repositories/message-search.js';
import { recomputeMemoryScopes, scopePermitted } from './search.js';
import type { MemoryStatus, MemoryType } from './repository.js';

/**
 * Memory deduplication candidates (Section 12.5).
 *
 * Before creating a memory, the host searches existing memories and surfaces
 * potential duplicates. Detection combines a stable normalized text key, FTS
 * similarity, same-type, and compatible effective scope. Crucially, uncertain
 * matches are returned as review candidates — the host never silently merges
 * unrelated claims. An *exact* duplicate (same normalized key and same type)
 * is flagged distinctly from an *ambiguous* lexical neighbor or a same-text
 * different-type memory.
 *
 * All candidates are recomputed-scope-filtered to the grant, so a memory the
 * caller cannot see is never proposed as a duplicate (Section 7.3).
 */

/** How strongly a candidate matches the input statement. */
export type MatchKind = 'exact' | 'ambiguous';

/**
 * Normalize a statement into a stable comparison key: lowercase, strip
 * apostrophes and punctuation, collapse whitespace. Two statements with the
 * same key are textually identical for deduplication purposes.
 */
export function normalizeStatement(statement: string): string {
  return statement
    .toLowerCase()
    .replace(/[''’]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface DuplicateCandidate {
  memoryId: string;
  statement: string;
  type: MemoryType;
  status: MemoryStatus;
  scopeType: string;
  scopeKey: string | null;
  matchKind: MatchKind;
  normalizedKey: string;
  /** BM25 rank within the candidate window (0 = closest lexical match). */
  rank: number;
}

export interface FindDuplicatesOptions {
  statement: string;
  /** When set, only same-type memories can be `exact`; others stay `ambiguous`. */
  type?: MemoryType;
  /** Upper bound on returned candidates (default 20). */
  limit?: number;
}

export interface FindDuplicatesResult {
  /** Normalized key of the input statement. */
  normalizedKey: string;
  candidates: DuplicateCandidate[];
  /** True when at least one same-type exact (normalized) match exists. */
  hasExact: boolean;
}

const CANDIDATE_CAP = 100;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

/**
 * Find potential duplicates of `statement` among grant-visible memories. The
 * FTS candidate window is recomputed-scope-filtered; each survivor is classified
 * `exact` (same normalized key and type) or `ambiguous` (lexical neighbor or
 * same text in a different category). Exact matches sort first; ambiguous
 * matches follow in BM25 order. No memory is mutated.
 */
export function findDuplicateCandidates(
  db: DatabaseSync,
  grant: RetrievalGrant,
  options: FindDuplicatesOptions,
): FindDuplicatesResult {
  const inputKey = normalizeStatement(options.statement);
  const match = sanitizeFtsQuery(options.statement);
  if (match === '') {
    return { normalizedKey: inputKey, candidates: [], hasExact: false };
  }

  const rows = prepareCached(
    db,
    'memory.dedup',
    `SELECT mem.id, mem.type, mem.statement, mem.status, mem.scope_type, mem.scope_key,
            bm25(memories_fts) AS bm25
       FROM memories_fts
       JOIN memories mem ON mem.rowid = memories_fts.rowid
      WHERE memories_fts MATCH ?
      ORDER BY bm25 ASC
      LIMIT ?`,
  ).all(match, CANDIDATE_CAP) as Array<Record<string, SQLOutputValue>>;

  const ids = rows.map((r) => String(r.id));
  const scopes = recomputeMemoryScopes(db, ids);

  const candidates: DuplicateCandidate[] = [];
  rows.forEach((row, index) => {
    const id = String(row.id);
    const scope = scopes.get(id);
    if (!scope || !scopePermitted(db, grant, scope)) return; // out of scope
    const type = String(row.type) as MemoryType;
    const candKey = normalizeStatement(String(row.statement));
    const sameType = options.type === undefined || options.type === type;
    const matchKind: MatchKind = candKey === inputKey && sameType ? 'exact' : 'ambiguous';
    candidates.push({
      memoryId: id,
      statement: String(row.statement),
      type,
      status: String(row.status) as MemoryStatus,
      scopeType: scope.scopeType,
      scopeKey: scope.scopeKey,
      matchKind,
      normalizedKey: candKey,
      rank: index,
    });
  });

  // Exact duplicates first; within each group preserve BM25 (lexical) order.
  candidates.sort((a, b) => {
    const ae = a.matchKind === 'exact' ? 0 : 1;
    const be = b.matchKind === 'exact' ? 0 : 1;
    return ae - be || a.rank - b.rank;
  });

  const limit = Math.max(1, Math.min(options.limit ?? DEFAULT_LIMIT, MAX_LIMIT));
  const limited = candidates.slice(0, limit);
  const hasExact = candidates.some((c) => c.matchKind === 'exact');
  return { normalizedKey: inputKey, candidates: limited, hasExact };
}
