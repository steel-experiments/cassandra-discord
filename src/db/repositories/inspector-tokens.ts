import { randomUUID } from 'node:crypto';
import { type DatabaseSync } from '../database.js';
import { prepareCached } from './util.js';

/**
 * Inspector bearer-token persistence (Section 32.6).
 *
 * The repository stores **only** the SHA-256 hash of each token in
 * `inspector_tokens` (migration 023). The plaintext 256-bit value is generated
 * and shown exactly once by the issuance path; it is never passed into this
 * module and never written to any column. Rows carry no scope fields: the
 * inspector grant is host-computed per request and equals the secure review
 * grant, so a token row is identity and lifecycle only.
 *
 * Every read here maps to a {@link SafeInspectorTokenRow} that omits
 * `token_hash` entirely, so neither the plaintext nor the hash can travel out
 * through the safe surface — the same projection discipline as mcp-tokens.
 */

/**
 * The safe projection of an `inspector_tokens` row. Deliberately carries no
 * `token_hash` and no plaintext: only what admin display and the request path
 * need.
 */
export interface SafeInspectorTokenRow {
  id: string;
  name: string;
  createdByUserId: string;
  createdAtMs: number;
  expiresAtMs: number | null;
  revokedAtMs: number | null;
  lastUsedAtMs: number | null;
}

/** Input for {@link insertInspectorToken}. The plaintext token is NEVER a field here. */
export interface InsertInspectorTokenInput {
  /** SHA-256 hex of the plaintext token value. This is the only secret-derived value stored. */
  tokenHash: string;
  name: string;
  createdByUserId: string;
  createdAtMs: number;
  expiresAtMs?: number | null;
}

/** Raw stored row (snake_case, includes the hash). Internal to this module. */
interface StoredInspectorTokenRow {
  id: string;
  name: string;
  token_hash: string;
  created_by_user_id: string;
  created_at_ms: number;
  expires_at_ms: number | null;
  revoked_at_ms: number | null;
  last_used_at_ms: number | null;
}

const SELECT_COLS = `id, name, token_hash, created_by_user_id, created_at_ms,
       expires_at_ms, revoked_at_ms, last_used_at_ms`;

/** Map a stored (snake_case) row to the safe projection. */
function toSafeRow(row: StoredInspectorTokenRow): SafeInspectorTokenRow {
  return {
    id: row.id,
    name: row.name,
    createdByUserId: row.created_by_user_id,
    createdAtMs: row.created_at_ms,
    expiresAtMs: row.expires_at_ms,
    revokedAtMs: row.revoked_at_ms,
    lastUsedAtMs: row.last_used_at_ms,
  };
}

/**
 * Persist a token row from its hash. The plaintext is not a parameter and is
 * never written. Returns the generated row id.
 */
export function insertInspectorToken(db: DatabaseSync, input: InsertInspectorTokenInput): string {
  const id = randomUUID();
  prepareCached(
    db,
    'inspector-tokens.insert',
    `INSERT INTO inspector_tokens (id, name, token_hash, created_by_user_id,
       created_at_ms, expires_at_ms, revoked_at_ms, last_used_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)`,
  ).run(
    id,
    input.name,
    input.tokenHash,
    input.createdByUserId,
    input.createdAtMs,
    input.expiresAtMs ?? null,
  );
  return id;
}

/**
 * Look up a token by its hash — the only read path that can authenticate a
 * presented bearer value, since the plaintext is never stored. Returns the safe
 * row or `undefined` when no token matches.
 */
export function getInspectorTokenByHash(
  db: DatabaseSync,
  tokenHash: string,
): SafeInspectorTokenRow | undefined {
  const row = prepareCached(
    db,
    'inspector-tokens.byHash',
    `SELECT ${SELECT_COLS} FROM inspector_tokens WHERE token_hash = ?`,
  ).get(tokenHash) as StoredInspectorTokenRow | undefined;
  return row ? toSafeRow(row) : undefined;
}

/** Read a token by id (admin display), or `undefined` when absent. */
export function getInspectorToken(db: DatabaseSync, id: string): SafeInspectorTokenRow | undefined {
  const row = prepareCached(
    db,
    'inspector-tokens.get',
    `SELECT ${SELECT_COLS} FROM inspector_tokens WHERE id = ?`,
  ).get(id) as StoredInspectorTokenRow | undefined;
  return row ? toSafeRow(row) : undefined;
}

/** List every token as a safe row, oldest first (admin display). */
export function listInspectorTokens(db: DatabaseSync): SafeInspectorTokenRow[] {
  const rows = prepareCached(
    db,
    'inspector-tokens.list',
    `SELECT ${SELECT_COLS} FROM inspector_tokens ORDER BY created_at_ms ASC`,
  ).all() as unknown as StoredInspectorTokenRow[];
  return rows.map(toSafeRow);
}

/**
 * Revoke a token immediately by setting `revoked_at_ms` (idempotent: a no-op
 * when already revoked or absent). Returns the number of rows changed.
 */
export function revokeInspectorToken(db: DatabaseSync, id: string, nowMs: number): number {
  return Number(
    prepareCached(
      db,
      'inspector-tokens.revoke',
      'UPDATE inspector_tokens SET revoked_at_ms = ? WHERE id = ? AND revoked_at_ms IS NULL',
    ).run(nowMs, id).changes,
  );
}

/**
 * Record that a token was used. Returns the number of rows changed.
 */
export function touchInspectorTokenLastUsed(db: DatabaseSync, id: string, nowMs: number): number {
  return Number(
    prepareCached(
      db,
      'inspector-tokens.touch',
      'UPDATE inspector_tokens SET last_used_at_ms = ? WHERE id = ?',
    ).run(nowMs, id).changes,
  );
}
