// ABOUTME: Persists in-flight MCP OAuth sign-ins between /authorize and the IdP return.
// ABOUTME: Rows are single-use, short-lived, and hold no credential.

import { randomBytes } from 'node:crypto';
import { type DatabaseSync } from '../database.js';
import { prepareCached } from './util.js';
import type { McpScopeType } from './mcp-tokens.js';

/**
 * Pending authorization requests (Section 32.5.2, amended; migration 013).
 *
 * A sign-in spans two HTTP requests that share no connection: the client reaches
 * `/authorize`, the person authenticates with Discord, and Discord returns them
 * to a separate callback. The request parameters have to survive that gap, and
 * they cannot be carried in the URL — a client-supplied `redirect_uri` that made
 * the round trip through the browser would be attacker-editable at exactly the
 * moment it decides where an authorization code is delivered. So the validated
 * parameters are written here and the identity provider is handed only an opaque
 * handle.
 *
 * Nothing stored is a credential. The PKCE `code_challenge` is a public value by
 * design (RFC 7636: the *verifier* is the secret, and it never reaches the
 * server until the token request). The row is deleted the first time it is
 * looked up, so a replayed return leg finds nothing.
 */

/** How long a person has to finish signing in before the request goes stale. */
export const LOGIN_SESSION_TTL_MS = 10 * 60_000;

/** Bytes of randomness in a session handle; it is guessed at, so make it wide. */
const SESSION_ID_BYTES = 32;

/** A validated authorization request, waiting for the person to authenticate. */
export interface LoginSession {
  id: string;
  clientId: string;
  redirectUri: string;
  /** The client's `state`, returned verbatim; null when the client sent none. */
  clientState: string | null;
  codeChallenge: string;
  resource: string;
  scope: string;
  createdAtMs: number;
  expiresAtMs: number;
}

/** Fields supplied at creation; the id and timestamps are assigned here. */
export interface CreateLoginSessionInput {
  clientId: string;
  /** Already checked against the registered redirect list. */
  redirectUri: string;
  clientState: string | null;
  codeChallenge: string;
  resource: string;
  scope: string;
  createdAtMs: number;
  ttlMs?: number;
}

interface StoredLoginSession {
  id: string;
  client_id: string;
  redirect_uri: string;
  client_state: string | null;
  code_challenge: string;
  resource: string;
  scope: string;
  created_at_ms: number;
  expires_at_ms: number;
}

/**
 * Record a validated authorization request and return its opaque handle. The
 * handle is the only thing that travels to the identity provider, so it is 256
 * bits of randomness rather than a sequence: a guessable handle would let a
 * caller complete somebody else's pending sign-in.
 */
export function createLoginSession(db: DatabaseSync, input: CreateLoginSessionInput): LoginSession {
  const session: LoginSession = {
    id: randomBytes(SESSION_ID_BYTES).toString('base64url'),
    clientId: input.clientId,
    redirectUri: input.redirectUri,
    clientState: input.clientState,
    codeChallenge: input.codeChallenge,
    resource: input.resource,
    scope: input.scope,
    createdAtMs: input.createdAtMs,
    expiresAtMs: input.createdAtMs + (input.ttlMs ?? LOGIN_SESSION_TTL_MS),
  };
  prepareCached(
    db,
    'oauth-flows.insert-session',
    `INSERT INTO oauth_login_sessions
       (id, client_id, redirect_uri, client_state, code_challenge, resource, scope,
        created_at_ms, expires_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    session.id,
    session.clientId,
    session.redirectUri,
    session.clientState,
    session.codeChallenge,
    session.resource,
    session.scope,
    session.createdAtMs,
    session.expiresAtMs,
  );
  return session;
}

/**
 * Look up a pending request by its handle and delete it in the same call, so a
 * handle works exactly once. An expired row is deleted and reported as absent —
 * a caller cannot tell a stale handle from a fabricated one, and either way
 * there is no request to resume.
 */
export function consumeLoginSession(
  db: DatabaseSync,
  id: string,
  nowMs: number,
): LoginSession | undefined {
  if (typeof id !== 'string' || id.length === 0) return undefined;
  const row = prepareCached(
    db,
    'oauth-flows.get-session',
    'SELECT * FROM oauth_login_sessions WHERE id = ?',
  ).get(id) as
    | StoredLoginSession
    | undefined;
  if (!row) return undefined;
  prepareCached(
    db,
    'oauth-flows.delete-session',
    'DELETE FROM oauth_login_sessions WHERE id = ?',
  ).run(id);
  if (row.expires_at_ms <= nowMs) return undefined;
  return {
    id: row.id,
    clientId: row.client_id,
    redirectUri: row.redirect_uri,
    clientState: row.client_state,
    codeChallenge: row.code_challenge,
    resource: row.resource,
    scope: row.scope,
    createdAtMs: row.created_at_ms,
    expiresAtMs: row.expires_at_ms,
  };
}

/**
 * Delete requests nobody finished. Abandoned sign-ins are the common case — a
 * person closes the browser sheet — so without a sweep the table only grows.
 * Returns the number of rows removed.
 */
export function purgeExpiredLoginSessions(db: DatabaseSync, nowMs: number, limit = 100): number {
  const cap = Math.min(1_000, Math.max(1, Math.floor(limit)));
  const result = prepareCached(
    db,
    'oauth-flows.purge-sessions',
    `DELETE FROM oauth_login_sessions
      WHERE rowid IN (
        SELECT rowid FROM oauth_login_sessions
         WHERE expires_at_ms <= ? ORDER BY expires_at_ms ASC LIMIT ?
      )`,
  ).run(nowMs, cap);
  return Number(result.changes ?? 0);
}

/**
 * How long a client has to redeem an authorization code. OAuth 2.1 recommends a
 * maximum of ten minutes and a code is normally redeemed within a second, so a
 * minute is generous while leaving almost no window for a stolen code.
 */
export const AUTHORIZATION_CODE_TTL_MS = 60_000;

/** An issued authorization code, as stored. Never carries the plaintext. */
export interface AuthorizationCodeRecord {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  scope: string;
  subjectUserId: string;
  scopeType: McpScopeType;
  channelIds: string[];
  createdAtMs: number;
  expiresAtMs: number;
  consumedAtMs: number | null;
}

/** Fields supplied when issuing; the caller has already hashed the code. */
export interface InsertAuthorizationCodeInput {
  /** SHA-256 hex of the plaintext code. The only code-derived value stored. */
  codeHash: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  scope: string;
  subjectUserId: string;
  scopeType: McpScopeType;
  channelIds: readonly string[];
  createdAtMs: number;
  ttlMs?: number;
}

interface StoredAuthorizationCode {
  code_hash: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  resource: string;
  scope: string;
  subject_user_id: string;
  scope_type: McpScopeType;
  channel_ids_json: string;
  created_at_ms: number;
  expires_at_ms: number;
  consumed_at_ms: number | null;
}

/** Record an issued code. The plaintext is never passed into this module. */
export function insertAuthorizationCode(
  db: DatabaseSync,
  input: InsertAuthorizationCodeInput,
): void {
  prepareCached(
    db,
    'oauth-flows.insert-code',
    `INSERT INTO oauth_authorization_codes
       (code_hash, client_id, redirect_uri, code_challenge, resource, scope,
        subject_user_id, scope_type, channel_ids_json, created_at_ms, expires_at_ms,
        consumed_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).run(
    input.codeHash,
    input.clientId,
    input.redirectUri,
    input.codeChallenge,
    input.resource,
    input.scope,
    input.subjectUserId,
    input.scopeType,
    JSON.stringify(input.channelIds),
    input.createdAtMs,
    input.createdAtMs + (input.ttlMs ?? AUTHORIZATION_CODE_TTL_MS),
  );
}

/**
 * Outcome of redeeming a code. `reused` is distinct from `invalid` on purpose:
 * a code presented twice means the first presentation may have been an
 * interception, and OAuth 2.1 Section 4.1.3 wants that treated as an incident
 * rather than an ordinary failure.
 */
export type ConsumeAuthorizationCodeOutcome =
  | { kind: 'valid'; record: AuthorizationCodeRecord }
  | { kind: 'invalid' }
  | { kind: 'expired' }
  | { kind: 'reused'; record: AuthorizationCodeRecord };

/**
 * Redeem a code by its hash, marking it consumed in the same call. Every failure
 * mode is reported to the caller as a distinct kind for logging, but all of them
 * are one indistinguishable `invalid_grant` to the client.
 */
export function consumeAuthorizationCode(
  db: DatabaseSync,
  codeHash: string,
  nowMs: number,
): ConsumeAuthorizationCodeOutcome {
  const row = prepareCached(
    db,
    'oauth-flows.get-code',
    'SELECT * FROM oauth_authorization_codes WHERE code_hash = ?',
  ).get(codeHash) as StoredAuthorizationCode | undefined;
  if (!row) return { kind: 'invalid' };
  const record = mapAuthorizationCode(row);
  if (record.consumedAtMs !== null) return { kind: 'reused', record };
  if (record.expiresAtMs <= nowMs) return { kind: 'expired' };
  prepareCached(
    db,
    'oauth-flows.consume-code',
    'UPDATE oauth_authorization_codes SET consumed_at_ms = ? WHERE code_hash = ? AND consumed_at_ms IS NULL',
  ).run(nowMs, codeHash);
  return { kind: 'valid', record };
}

/**
 * Delete codes that can no longer be redeemed. A consumed row is kept for a grace
 * period past its expiry so a replay arriving moments later is still recognized
 * as a replay rather than as an unknown code.
 */
export function purgeExpiredAuthorizationCodes(db: DatabaseSync, nowMs: number, limit = 100): number {
  const cap = Math.min(1_000, Math.max(1, Math.floor(limit)));
  const result = prepareCached(
    db,
    'oauth-flows.purge-codes',
    `DELETE FROM oauth_authorization_codes
      WHERE rowid IN (
        SELECT rowid FROM oauth_authorization_codes
         WHERE expires_at_ms <= ? ORDER BY expires_at_ms ASC LIMIT ?
      )`,
  ).run(nowMs - AUTHORIZATION_CODE_TTL_MS, cap);
  return Number(result.changes ?? 0);
}

/** How long a refresh token stays usable. Rotated on every exchange. */
export const REFRESH_TOKEN_TTL_MS = 90 * 86_400_000;

/** Keep expired/revoked OAuth access rows briefly for operator visibility. */
export const OAUTH_ACCESS_TOKEN_PURGE_GRACE_MS = 60 * 60_000;

/** Purge only OAuth-issued access rows, in a bounded batch. Admin tokens are untouched. */
export function purgeExpiredOAuthAccessTokens(
  db: DatabaseSync,
  nowMs: number,
  limit = 100,
): number {
  const cap = Math.min(1_000, Math.max(1, Math.floor(limit)));
  const cutoff = nowMs - OAUTH_ACCESS_TOKEN_PURGE_GRACE_MS;
  const result = prepareCached(
    db,
    'oauth-flows.purge-access-tokens',
    `DELETE FROM mcp_tokens
      WHERE rowid IN (
        SELECT rowid FROM mcp_tokens
         WHERE oauth_family_id IS NOT NULL
           AND ((expires_at_ms IS NOT NULL AND expires_at_ms <= ?)
             OR (revoked_at_ms IS NOT NULL AND revoked_at_ms <= ?))
         ORDER BY COALESCE(revoked_at_ms, expires_at_ms) ASC LIMIT ?
      )`,
  ).run(cutoff, cutoff, cap);
  return Number(result.changes ?? 0);
}

/** A stored refresh token, minus its plaintext. */
export interface RefreshTokenRecord {
  familyId: string;
  clientId: string;
  subjectUserId: string;
  scope: string;
  scopeType: McpScopeType;
  channelIds: string[];
  createdAtMs: number;
  expiresAtMs: number;
  consumedAtMs: number | null;
}

/** Fields supplied when issuing; the caller has already hashed the token. */
export interface InsertRefreshTokenInput {
  tokenHash: string;
  familyId: string;
  clientId: string;
  subjectUserId: string;
  scope: string;
  scopeType: McpScopeType;
  channelIds: readonly string[];
  createdAtMs: number;
  ttlMs?: number;
}

interface StoredRefreshToken {
  token_hash: string;
  family_id: string;
  client_id: string;
  subject_user_id: string;
  scope: string;
  scope_type: McpScopeType;
  channel_ids_json: string;
  created_at_ms: number;
  expires_at_ms: number;
  consumed_at_ms: number | null;
}

/** Record an issued refresh token. Only the hash is written. */
export function insertRefreshToken(db: DatabaseSync, input: InsertRefreshTokenInput): void {
  prepareCached(
    db,
    'oauth-flows.insert-refresh',
    `INSERT INTO oauth_refresh_tokens
       (token_hash, family_id, client_id, subject_user_id, scope, scope_type,
        channel_ids_json, created_at_ms, expires_at_ms, consumed_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).run(
    input.tokenHash,
    input.familyId,
    input.clientId,
    input.subjectUserId,
    input.scope,
    input.scopeType,
    JSON.stringify(input.channelIds),
    input.createdAtMs,
    input.createdAtMs + (input.ttlMs ?? REFRESH_TOKEN_TTL_MS),
  );
}

/**
 * Outcome of exchanging a refresh token. `reused` carries the family so the
 * caller can end it: a token presented twice means a copy escaped, and the
 * legitimate client cannot be distinguished from the thief.
 */
export type ConsumeRefreshTokenOutcome =
  | { kind: 'valid'; record: RefreshTokenRecord }
  | { kind: 'invalid' }
  | { kind: 'expired' }
  | { kind: 'reused'; familyId: string };

/** Exchange a refresh token by its hash, marking it consumed in the same call. */
export function consumeRefreshToken(
  db: DatabaseSync,
  tokenHash: string,
  nowMs: number,
): ConsumeRefreshTokenOutcome {
  const row = prepareCached(
    db,
    'oauth-flows.get-refresh',
    'SELECT * FROM oauth_refresh_tokens WHERE token_hash = ?',
  ).get(tokenHash) as StoredRefreshToken | undefined;
  if (!row) return { kind: 'invalid' };
  if (row.consumed_at_ms !== null) return { kind: 'reused', familyId: row.family_id };
  if (row.expires_at_ms <= nowMs) return { kind: 'expired' };
  prepareCached(
    db,
    'oauth-flows.consume-refresh',
    'UPDATE oauth_refresh_tokens SET consumed_at_ms = ? WHERE token_hash = ? AND consumed_at_ms IS NULL',
  ).run(nowMs, tokenHash);
  return {
    kind: 'valid',
    record: {
      familyId: row.family_id,
      clientId: row.client_id,
      subjectUserId: row.subject_user_id,
      scope: row.scope,
      scopeType: row.scope_type,
      channelIds: parseChannelIds(row.channel_ids_json),
      createdAtMs: row.created_at_ms,
      expiresAtMs: row.expires_at_ms,
      consumedAtMs: row.consumed_at_ms,
    },
  };
}

/**
 * End a refresh chain by consuming every token in it. Paired with
 * {@link ../repositories/mcp-tokens.js revokeMcpTokenFamily}, which ends the
 * access tokens. Rows are marked rather than deleted so a further replay is
 * still recognized. Returns the number of tokens ended.
 */
export function revokeRefreshTokenFamily(db: DatabaseSync, familyId: string, nowMs: number): number {
  const result = prepareCached(
    db,
    'oauth-flows.revoke-refresh-family',
    'UPDATE oauth_refresh_tokens SET consumed_at_ms = ? WHERE family_id = ? AND consumed_at_ms IS NULL',
  ).run(nowMs, familyId);
  return Number(result.changes ?? 0);
}

/**
 * Delete refresh rows only after their normal lifetime plus one additional
 * replay-detection window. The bounded rowid subquery prevents one request from
 * turning expiry maintenance into an unbounded write transaction.
 */
export function purgeExpiredRefreshTokens(
  db: DatabaseSync,
  nowMs: number,
  limit = 100,
): number {
  const cap = Math.min(1_000, Math.max(1, Math.floor(limit)));
  const result = prepareCached(
    db,
    'oauth-flows.purge-refresh',
    `DELETE FROM oauth_refresh_tokens
      WHERE rowid IN (
        SELECT rowid FROM oauth_refresh_tokens
         WHERE expires_at_ms <= ?
         ORDER BY expires_at_ms ASC
         LIMIT ?
      )`,
  ).run(nowMs - REFRESH_TOKEN_TTL_MS, cap);
  return Number(result.changes ?? 0);
}

function mapAuthorizationCode(row: StoredAuthorizationCode): AuthorizationCodeRecord {
  return {
    clientId: row.client_id,
    redirectUri: row.redirect_uri,
    codeChallenge: row.code_challenge,
    resource: row.resource,
    scope: row.scope,
    subjectUserId: row.subject_user_id,
    scopeType: row.scope_type,
    channelIds: parseChannelIds(row.channel_ids_json),
    createdAtMs: row.created_at_ms,
    expiresAtMs: row.expires_at_ms,
    consumedAtMs: row.consumed_at_ms,
  };
}

function parseChannelIds(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}
