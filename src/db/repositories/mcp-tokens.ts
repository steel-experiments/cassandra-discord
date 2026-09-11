import { randomUUID } from 'node:crypto';
import { type DatabaseSync } from '../database.js';
import { prepareCached } from './util.js';

/**
 * MCP bearer-token persistence (Sections 27, 32.5.2, 44).
 *
 * The repository stores **only** the SHA-256 hash of each token in `mcp_tokens`
 * (migration 003). The plaintext 256-bit value is generated and shown exactly
 * once by {@link ../../mcp/auth.ts createMcpToken}; it is never passed into this
 * module and never written to any column. Every row read here is mapped to a
 * {@link SafeMcpTokenRow} that omits `token_hash` entirely, so neither the
 * plaintext nor the hash can travel out through the safe surface — only ids,
 * names, the resolved scope grant, timestamps, and the creator id.
 *
 * Tokens support expiry (`expires_at_ms`) and revocation (`revoked_at_ms`); every
 * authenticated use updates `last_used_at_ms` via {@link touchMcpTokenLastUsed}.
 * The grant is `org` by default, or `org_plus_channels` with an explicit list of
 * restricted channel ids — never `review_only` (enforced before insert, in
 * `auth.ts`, since the channel table is what defines a channel's class).
 */

/** The two `scope_type` values accepted by the schema CHECK. */
export type McpScopeType = 'org' | 'org_plus_channels';

/**
 * The safe projection of an `mcp_tokens` row. Deliberately carries no
 * `token_hash` and no plaintext: only what an admin display or the MCP request
 * path needs to resolve the grant.
 */
export interface SafeMcpTokenRow {
  id: string;
  name: string;
  scopeType: McpScopeType;
  /** Restricted channel ids granted to the token (empty for `org` scope). */
  channelIds: string[];
  createdByUserId: string;
  createdAtMs: number;
  expiresAtMs: number | null;
  revokedAtMs: number | null;
  lastUsedAtMs: number | null;
}

/** Input for {@link insertMcpToken}. The plaintext token is NEVER a field here. */
export interface InsertMcpTokenInput {
  /** SHA-256 hex of the plaintext token value. This is the only secret-derived value stored. */
  tokenHash: string;
  name: string;
  scopeType: McpScopeType;
  channelIds: readonly string[];
  createdByUserId: string;
  createdAtMs: number;
  expiresAtMs?: number | null;
  /**
   * The Discord user an OAuth-issued token speaks for. Absent on admin-issued
   * tokens, which represent a grant rather than a person.
   */
  subjectUserId?: string | null;
  /**
   * Refresh chain this token descends from. Revoking a chain revokes every
   * access token that carries its id. Absent on admin-issued tokens.
   */
  oauthFamilyId?: string | null;
}

/** Raw stored row (snake_case, includes the hash). Internal to this module. */
interface StoredMcpTokenRow {
  id: string;
  name: string;
  token_hash: string;
  scope_type: McpScopeType;
  channel_ids_json: string;
  created_by_user_id: string;
  created_at_ms: number;
  expires_at_ms: number | null;
  revoked_at_ms: number | null;
  last_used_at_ms: number | null;
}

const SELECT_COLS = `id, name, token_hash, scope_type, channel_ids_json,
       created_by_user_id, created_at_ms, expires_at_ms, revoked_at_ms, last_used_at_ms`;

/**
 * Parse the `channel_ids_json` column defensively. A well-formed row stores a
 * JSON array of strings; a corrupt or hand-edited value degrades to an empty
 * grant rather than throwing, so the MCP request path never crashes on storage.
 */
function parseChannelIds(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === 'string')
      : [];
  } catch {
    return [];
  }
}

/** Map a stored (snake_case) row to the safe projection. */
function toSafeRow(row: StoredMcpTokenRow): SafeMcpTokenRow {
  return {
    id: row.id,
    name: row.name,
    scopeType: row.scope_type,
    channelIds: parseChannelIds(row.channel_ids_json),
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
export function insertMcpToken(db: DatabaseSync, input: InsertMcpTokenInput): string {
  const id = randomUUID();
  prepareCached(
    db,
    'mcp-tokens.insert',
    `INSERT INTO mcp_tokens (id, name, token_hash, scope_type, channel_ids_json,
       created_by_user_id, created_at_ms, expires_at_ms, revoked_at_ms, last_used_at_ms,
       subject_user_id, oauth_family_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
  ).run(
    id,
    input.name,
    input.tokenHash,
    input.scopeType,
    JSON.stringify(input.channelIds),
    input.createdByUserId,
    input.createdAtMs,
    input.expiresAtMs ?? null,
    input.subjectUserId ?? null,
    input.oauthFamilyId ?? null,
  );
  return id;
}

/**
 * Revoke every access token descended from one sign-in. Called when a refresh
 * token is presented twice: either the client or a thief holds a copy and there
 * is no way to tell which, so OAuth 2.1 Section 4.3.1 requires the whole chain to
 * end. Returns the number of tokens revoked.
 */
export function revokeMcpTokenFamily(db: DatabaseSync, familyId: string, nowMs: number): number {
  const result = prepareCached(
    db,
    'mcp-tokens.revoke-family',
    'UPDATE mcp_tokens SET revoked_at_ms = ? WHERE oauth_family_id = ? AND revoked_at_ms IS NULL',
  ).run(nowMs, familyId);
  return Number(result.changes ?? 0);
}

/**
 * Look up a token by its hash — the only read path that can authenticate a
 * presented bearer value, since the plaintext is never stored. Returns the safe
 * row or `undefined` when no token matches.
 */
export function getMcpTokenByHash(db: DatabaseSync, tokenHash: string): SafeMcpTokenRow | undefined {
  const row = prepareCached(
    db,
    'mcp-tokens.byHash',
    `SELECT ${SELECT_COLS} FROM mcp_tokens WHERE token_hash = ?`,
  ).get(tokenHash) as StoredMcpTokenRow | undefined;
  return row ? toSafeRow(row) : undefined;
}

/** Read a token by id (admin display), or `undefined` when absent. */
export function getMcpToken(db: DatabaseSync, id: string): SafeMcpTokenRow | undefined {
  const row = prepareCached(
    db,
    'mcp-tokens.get',
    `SELECT ${SELECT_COLS} FROM mcp_tokens WHERE id = ?`,
  ).get(id) as StoredMcpTokenRow | undefined;
  return row ? toSafeRow(row) : undefined;
}

/** List every token as a safe row, oldest first (admin display). */
export function listMcpTokens(db: DatabaseSync): SafeMcpTokenRow[] {
  const rows = prepareCached(
    db,
    'mcp-tokens.list',
    `SELECT ${SELECT_COLS} FROM mcp_tokens ORDER BY created_at_ms ASC`,
  ).all() as unknown as StoredMcpTokenRow[] | undefined;
  return (rows ?? []).map(toSafeRow);
}

/**
 * Revoke a token immediately by setting `revoked_at_ms` (idempotent: a no-op when
 * already revoked or absent). Returns the number of rows changed.
 */
export function revokeMcpToken(db: DatabaseSync, id: string, nowMs: number): number {
  return Number(
    prepareCached(
      db,
      'mcp-tokens.revoke',
      'UPDATE mcp_tokens SET revoked_at_ms = ? WHERE id = ? AND revoked_at_ms IS NULL',
    ).run(nowMs, id).changes,
  );
}

/**
 * Record that a token was used (Section 32.5.2: "every use updates
 * `last_used_at_ms`"). Returns the number of rows changed.
 */
export function touchMcpTokenLastUsed(db: DatabaseSync, id: string, nowMs: number): number {
  return Number(
    prepareCached(
      db,
      'mcp-tokens.touch',
      'UPDATE mcp_tokens SET last_used_at_ms = ? WHERE id = ?',
    ).run(nowMs, id).changes,
  );
}
