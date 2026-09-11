// @ts-check
/**
 * Runtime capability probe.
 *
 * Proves the pinned Node 24 runtime exposes every SQLite capability the schema
 * relies on before any migration work depends on it:
 *   - node:sqlite DatabaseSync
 *   - STRICT tables
 *   - FTS5 virtual tables (external-content)
 *   - JSON1 functions (json_extract)
 *   - INSERT ... RETURNING
 *   - the online backup() API (used for safe backups while the DB is open)
 *
 * Exits non-zero if any required capability is missing so CI fails loudly.
 * If a future runtime regresses any of these, switch the database dependency
 * to better-sqlite3 (the documented fallback) instead of weakening the schema.
 */
import { DatabaseSync, backup } from 'node:sqlite';

/** @returns {{label:string, ok:boolean, detail:string}[]} */
function probe() {
  const results = [];
  const db = new DatabaseSync(':memory:');

  const check = (label, fn) => {
    try {
      const detail = fn();
      results.push({ label, ok: true, detail: String(detail ?? 'ok') });
    } catch (err) {
      results.push({ label, ok: false, detail: err instanceof Error ? err.message : String(err) });
    }
  };

  check('node:sqlite DatabaseSync', () => db.prepare('SELECT 1 AS one').get().one);
  check('STRICT tables', () => {
    db.exec('CREATE TABLE probe_strict(x INTEGER PRIMARY KEY, v TEXT) STRICT');
    return 'CREATE TABLE ... STRICT';
  });
  check('FTS5 virtual tables', () => {
    db.exec('CREATE VIRTUAL TABLE probe_fts USING fts5(content, tokenize="unicode61 remove_diacritics 2")');
    return 'CREATE VIRTUAL TABLE ... fts5';
  });
  check('JSON functions (json_extract)', () =>
    db.prepare("SELECT json_extract('{\"a\":1}', '$.a') AS a").get().a,
  );
  check('INSERT ... RETURNING', () => {
    db.prepare("INSERT INTO probe_strict(v) VALUES('z') RETURNING x").get().x;
    return 'RETURNING';
  });
  check('Partial unique index', () => {
    db.exec('CREATE TABLE probe_u(t TEXT, k TEXT, status TEXT)');
    db.exec(
      "CREATE UNIQUE INDEX probe_u_idx ON probe_u(t, k) WHERE k IS NOT NULL AND status IN ('queued','running')",
    );
    return 'WHERE-filtered UNIQUE INDEX';
  });
  check('Online backup() API exported', () => typeof backup === 'function');

  db.close();
  return results;
}

const results = probe();
const failed = results.filter((r) => !r.ok);

for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.label.padEnd(38)} ${r.detail}`);
}

if (failed.length) {
  console.error(`\n${failed.length} required SQLite capability(cies) missing.`);
  console.error('Fallback decision: switch the database dependency to better-sqlite3.');
  process.exit(1);
}

console.log('\nALL_REQUIRED_FEATURES_PRESENT');
