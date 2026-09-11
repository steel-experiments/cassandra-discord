import { type DatabaseSync, type StatementSync } from '../database.js';

/**
 * Per-connection prepared-statement cache. node:sqlite prepared statements are
 * bound to the database they were created from; a WeakMap keyed on the
 * connection keeps caches scoped to the connection's lifetime.
 */
const statementCache = new WeakMap<DatabaseSync, Map<string, StatementSync>>();
export const MAX_PREPARED_STATEMENTS_PER_CONNECTION = 256;

/**
 * Prepare (once per connection) and return a named-parameter statement. Bare
 * JavaScript keys bind to `@name` placeholders in SQL.
 */
export function prepareCached(db: DatabaseSync, key: string, sql: string): StatementSync {
  let cache = statementCache.get(db);
  if (cache === undefined) {
    cache = new Map();
    statementCache.set(db, cache);
  }
  let stmt = cache.get(key);
  if (stmt === undefined) {
    stmt = db.prepare(sql);
    stmt.setAllowBareNamedParameters(true);
    cache.set(key, stmt);
    if (cache.size > MAX_PREPARED_STATEMENTS_PER_CONNECTION) {
      const oldest = cache.keys().next().value as string | undefined;
      if (oldest !== undefined) cache.delete(oldest);
    }
  } else {
    // Map insertion order provides a compact deterministic LRU. StatementSync
    // has no public finalize method in Node 24; eviction releases our strong
    // reference so the native statement can be reclaimed by GC.
    cache.delete(key);
    cache.set(key, stmt);
  }
  return stmt;
}

/** Test/metrics seam exposing cardinality only, never statement keys or SQL. */
export function preparedStatementCacheSize(db: DatabaseSync): number {
  return statementCache.get(db)?.size ?? 0;
}

/** SQLite has no native BOOLEAN; STRICT integer columns store 0/1. */
export function toInt(value: boolean): 0 | 1 {
  return value ? 1 : 0;
}
