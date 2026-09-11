import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createTestDb, seedIdentity, makeTempDir, type TestDb } from '../helpers/db.js';
import { openDatabase } from '../../src/db/database.js';
import { GUILD, CHANNEL, NOW, ftsMatches } from '../helpers/messages.js';
import { upsertMessageCreate } from '../../src/db/repositories/messages.js';
import {
  createBackup,
  integrityCheck,
  type BackupManifest,
} from '../../src/db/backup.js';
import { applyMigrations, listAppliedMigrations } from '../../src/db/migrations.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));

/**
 * Section 46.5 chaos case 7 — "restore from backup", and case 8 — "deploy a
 * schema migration and roll back application code".
 *
 * Case 7 verdict (Section 42.3 restore procedure): a backup taken while the
 * source is live opens standalone after restore — it passes integrity_check, its
 * schema version matches the source, re-running the migration runner is a no-op,
 * and the FTS index still returns the backed-up messages. No data is lost and no
 * restricted content escapes its scope (the restored DB is a byte-for-byte
 * snapshot with the same visibility classes).
 *
 * Case 8 verdict: the migration runner is idempotent and drift-checked, so
 * restarting on the current schema (including with older application code that
 * knows nothing of newer columns) applies nothing and corrupts nothing; a
 * migration file edited after being applied is refused rather than silently
 * applied. (The deeper idempotency/drift/rollback unit cases live in
 * `test/unit/migrations.test.ts`; this file covers the restore-time angle.)
 */

function addMessage(id: string, content: string, createdAtMs: number, dbParam?: TestDb['db']): void {
  upsertMessageCreate(dbParam ?? env.db, {
    id,
    guildId: GUILD,
    channelId: CHANNEL,
    authorId: '100000000000000003',
    authorDisplayName: 'Alice',
    content,
    createdAtMs,
    editedAtMs: null,
    replyToMessageId: null,
    messageType: 0,
    flags: 0,
    pinned: false,
    mentionEveryone: false,
    mentionsJson: '[]',
    embedsJson: '[]',
    componentsJson: '[]',
    pollJson: null,
    rawJson: null,
    ingestedAtMs: createdAtMs,
    updatedAtMs: createdAtMs,
  });
}

let env: TestDb;
let backupsDir: string;

beforeEach(() => {
  env = createTestDb();
  seedIdentity(env.db);
  backupsDir = makeTempDir();
});
afterEach(() => {
  env.cleanup();
  rmSync(backupsDir, { recursive: true, force: true });
});

/** The highest applied migration version on a database (its schema version). */
function schemaVersion(db: import('node:sqlite').DatabaseSync): number {
  const applied = listAppliedMigrations(db);
  return applied.length ? (applied[applied.length - 1]!.version as number) : 0;
}

describe('Section 46.5 — restore from backup (case 7)', { timeout: 15_000 }, () => {
  it('restores a standalone snapshot: integrity ok, schema matches, migrations no-op, FTS intact', async () => {
    // Live data, including a phrase we will look up via FTS after restore.
    addMessage('m-restore-1', 'decision restore sentinel alpha beta', NOW);
    addMessage('m-restore-2', 'a second committed message', NOW + 1);
    expect(ftsMatches(env.db, 'restore sentinel')).toBe(true);
    const sourceVersion = schemaVersion(env.db);

    // Take an online backup while the source connection is still open.
    const { backupPath, manifest } = await createBackup({
      db: env.db,
      backupsDir,
      sourceDatabasePath: env.path,
      appVersion: 'chaos-test',
      now: NOW + 1_000,
    });

    // §42.3 step 5: integrity check on the completed backup.
    expect(integrityCheck(backupPath)).toBe('ok');

    // §42.3 step 3-6: place the backup as the live database and start.
    const restored = openDatabase(backupPath);
    try {
      // §42.3 step 7: confirm schema version matches the source.
      expect(schemaVersion(restored)).toBe(sourceVersion);
      // The manifest's recorded schema version agrees with the restored DB.
      expect((manifest as BackupManifest).schemaVersion).toBe(sourceVersion);

      // Re-running the migration runner on the restored DB is a no-op: nothing
      // new applies, nothing is corrupted (idempotent restart).
      const result = applyMigrations(restored, MIGRATIONS_DIR, () => NOW + 2_000);
      expect(result.applied).toEqual([]);
      expect(schemaVersion(restored)).toBe(sourceVersion);

      // §48 Storage: "FTS returns permitted messages and memories" — the FTS
      // index survived the snapshot/restore and still resolves the phrase.
      expect(ftsMatches(restored, 'restore sentinel')).toBe(true);
      expect(ftsMatches(restored, 'second committed')).toBe(true);

      // Row count round-trips exactly.
      const count = (
        restored.prepare('SELECT COUNT(*) AS c FROM messages').get() as { c: number }
      ).c;
      expect(count).toBe(2);

      // The restored DB carries the same visibility classes (no scope leak).
      const vis = restored
        .prepare("SELECT visibility_class FROM channels WHERE id = ?")
        .get(CHANNEL) as { visibility_class: string };
      expect(vis.visibility_class).toBe('restricted');
    } finally {
      restored.close();
    }
  }, 15_000);

  it('a restored backup does not contain rows committed on the source after the snapshot', async () => {
    addMessage('before', 'committed before the snapshot', NOW);
    const { backupPath } = await createBackup({
      db: env.db,
      backupsDir,
      sourceDatabasePath: env.path,
      appVersion: 'chaos-test',
      now: NOW + 500,
    });
    // A row committed on the live source AFTER the backup must not appear.
    addMessage('after', 'committed after the snapshot', NOW + 5_000);

    const restored = openDatabase(backupPath);
    try {
      expect(ftsMatches(restored, 'after the snapshot')).toBe(false);
      expect(ftsMatches(restored, 'before the snapshot')).toBe(true);
    } finally {
      restored.close();
    }
  });
});
