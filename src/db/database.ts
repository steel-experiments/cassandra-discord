import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type { DatabaseSync, StatementSync } from 'node:sqlite';

/**
 * Canonical SQLite pragmas (Section 28).
 *
 * foreign_keys fails closed on cross-scope references; WAL enables concurrent
 * reads; busy_timeout waits rather than failing under lock contention;
 * trusted_schema off disables function lookup from untrusted schemas; extension
 * loading is disabled at construction (allowExtension: false).
 */
export const CANONICAL_PRAGMAS = [
  'PRAGMA foreign_keys = ON',
  'PRAGMA journal_mode = WAL',
  'PRAGMA synchronous = NORMAL',
  'PRAGMA busy_timeout = 5000',
  'PRAGMA temp_store = MEMORY',
  'PRAGMA wal_autocheckpoint = 1000',
  'PRAGMA trusted_schema = OFF',
] as const;

export interface OpenDatabaseOptions {
  /** Open read-only (the database must already exist). */
  readOnly?: boolean;
}

/**
 * Open the single application database connection and apply the canonical
 * pragmas. Creates the parent data directory when writing.
 */
export function openDatabase(path: string, options: OpenDatabaseOptions = {}): DatabaseSync {
  if (!options.readOnly) {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new DatabaseSync(path, {
    readOnly: options.readOnly,
    enableForeignKeyConstraints: true,
    allowExtension: false,
    timeout: 5000,
  });
  // Defense-in-depth: extensions stay disabled even if a future caller toggles.
  try {
    db.enableLoadExtension(false);
  } catch {
    // Method presence is guaranteed by the option above; ignore defensively.
  }
  for (const pragma of CANONICAL_PRAGMAS) {
    db.exec(pragma);
  }
  return db;
}

/** Read a single pragma value (used by tests and the status endpoint). */
export function getPragma(db: DatabaseSync, name: string): string | number | null {
  const row = db.prepare(`PRAGMA ${name}`).get() as Record<string, string | number | null> | undefined;
  if (!row) return null;
  const values = Object.values(row);
  return values.length > 0 ? (values[0] ?? null) : null;
}

/**
 * Run `fn` inside a short transaction. Transactions must stay short and must not
 * perform model or Discord network calls (Section 28). Rolls back on any throw.
 */
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  return runInTransaction(db, 'BEGIN', fn);
}

/**
 * Run `fn` inside a `BEGIN IMMEDIATE` transaction, acquiring the write lock up
 * front. Use for claim/lease operations that must serialize across would-be
 * concurrent claimants (Section 10). Rolls back on any throw.
 */
export function transactionImmediate<T>(db: DatabaseSync, fn: () => T): T {
  return runInTransaction(db, 'BEGIN IMMEDIATE', fn);
}

function runInTransaction<T>(db: DatabaseSync, begin: string, fn: () => T): T {
  db.exec(begin);
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Ignore a failed rollback; the original error is what matters.
    }
    throw err;
  }
}
