import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { transaction, type DatabaseSync } from './database.js';

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationError';
  }
}

const MIGRATION_RE = /^(\d{3})_([a-z0-9_]+)\.sql$/;

export interface DiscoveredMigration {
  version: number;
  name: string;
  path: string;
}

export interface AppliedMigration {
  version: number;
  name: string;
  checksum: string;
}

/**
 * SHA-256 hex digest of a migration file's contents. Used to detect edits to an
 * already-applied migration (drift), which must fail startup.
 */
export function computeChecksum(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Create the migration bookkeeping table. This table is meta-state owned by the
 * runner; domain tables live in the numbered migration files.
 *
 * Note (spec amendment): Section 29 lists `schema_migrations(version, name,
 * applied_at_ms)`. A `checksum TEXT NOT NULL` column is added to make migration
 * content immutable after application, satisfying the "checksum-safe
 * application" requirement. Amendment recorded in the spec.
 */
export function ensureMigrationsTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at_ms INTEGER NOT NULL
    ) STRICT;
  `);
}

/** Discover numbered migration files, validating contiguity and uniqueness. */
export function discoverMigrations(dir: string): DiscoveredMigration[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const found: DiscoveredMigration[] = [];
  const seen = new Set<number>();
  for (const entry of entries) {
    const match = MIGRATION_RE.exec(entry);
    if (!match) continue;
    const version = Number(match[1]);
    if (seen.has(version)) {
      throw new MigrationError(`duplicate migration version ${version}`);
    }
    seen.add(version);
    found.push({ version, name: match[2] as string, path: join(dir, entry) });
  }
  found.sort((a, b) => a.version - b.version);
  for (let i = 0; i < found.length; i++) {
    const m = found[i];
    if (!m) continue;
    if (m.version !== i + 1) {
      throw new MigrationError(
        `migration versions must be contiguous starting at 1: expected version ${i + 1}, found ${m.version} (${m.name})`,
      );
    }
  }
  return found;
}

/** List already-applied migrations, ordered by version. */
export function listAppliedMigrations(db: DatabaseSync): AppliedMigration[] {
  ensureMigrationsTable(db);
  const rows = db
    .prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version')
    .all() as unknown as AppliedMigration[];
  return rows;
}

/**
 * Apply all pending migrations in order. Each migration runs in its own
 * transaction; a failed migration rolls back fully while prior migrations stay
 * committed. Throws on version drift, missing files, or checksum mismatch.
 */
export function applyMigrations(
  db: DatabaseSync,
  dir: string,
  now: () => number = Date.now,
): { applied: DiscoveredMigration[] } {
  ensureMigrationsTable(db);
  const discovered = discoverMigrations(dir);
  const applied = listAppliedMigrations(db);

  if (applied.length > discovered.length) {
    throw new MigrationError(
      `database has ${applied.length} migrations applied but only ${discovered.length} are present; a migration file is missing`,
    );
  }

  for (let i = 0; i < applied.length; i++) {
    const appliedRow = applied[i];
    if (!appliedRow) continue;
    const expected = discovered[i];
    if (!expected) {
      throw new MigrationError(`applied version ${appliedRow.version} has no matching file`);
    }
    if (appliedRow.version !== expected.version) {
      throw new MigrationError(
        `migration version drift: database expects version ${appliedRow.version} at position ${i + 1}, files provide ${expected.version}`,
      );
    }
    if (appliedRow.name !== expected.name) {
      throw new MigrationError(
        `migration ${expected.version} was applied as "${appliedRow.name}" but the file is now named "${expected.name}"`,
      );
    }
    const fileChecksum = computeChecksum(readFileSync(expected.path, 'utf8'));
    if (appliedRow.checksum !== fileChecksum) {
      throw new MigrationError(
        `migration ${expected.version} ("${expected.name}") was modified after being applied; refusing to proceed`,
      );
    }
  }

  const newlyApplied: DiscoveredMigration[] = [];
  for (let i = applied.length; i < discovered.length; i++) {
    const migration = discovered[i];
    if (!migration) continue;
    const sql = readFileSync(migration.path, 'utf8');
    const checksum = computeChecksum(sql);
    transaction(db, () => {
      db.exec(sql);
      db
        .prepare('INSERT INTO schema_migrations (version, name, checksum, applied_at_ms) VALUES (?, ?, ?, ?)')
        .run(migration.version, migration.name, checksum, now());
    });
    newlyApplied.push(migration);
  }
  return { applied: newlyApplied };
}
