import { randomBytes, createHash } from 'node:crypto';
import { type DatabaseSync } from '../../db/database.js';
import {
  insertInspectorToken,
  getInspectorTokenByHash,
  touchInspectorTokenLastUsed,
  type SafeInspectorTokenRow,
} from '../../db/repositories/inspector-tokens.js';

/**
 * Inspector bearer-token issuance and resolution (Section 32.6).
 *
 * Mirrors the MCP credential discipline (Section 32.5.2) with one deliberate
 * difference: an inspector token carries no scope. The inspector grant is
 * host-computed per request and always equals the secure review grant, so the
 * token row is identity and lifecycle only — nothing a caller could widen or
 * narrow.
 *
 * This module is the single place that holds the plaintext token value, and
 * only for the duration of {@link createInspectorToken}: the value is
 * generated, hashed, the hash is persisted via the repository, and the
 * plaintext is returned to the caller exactly once. It is never written to
 * SQLite, never placed in a log field, and never held on a row object.
 * {@link resolveInspectorToken} is the counterpart: it hashes a presented value
 * and looks the token up by its hash, which is the only way to validate a
 * credential whose plaintext was never kept.
 */

export type { SafeInspectorTokenRow } from '../../db/repositories/inspector-tokens.js';

/** A token is 256 bits of randomness (Section 32.5.2 discipline). */
export const INSPECTOR_TOKEN_BYTES = 32;

/**
 * Default token lifetime when no expiry is requested: 30 days. Shorter than
 * MCP's 90 because an inspector token reads the widest grant in the system
 * (org + restricted + review_only) through a browser-reachable surface.
 */
export const DEFAULT_INSPECTOR_TOKEN_TTL_DAYS = 30;
/** {@link DEFAULT_INSPECTOR_TOKEN_TTL_DAYS} in milliseconds. */
export const DEFAULT_INSPECTOR_TOKEN_TTL_MS = DEFAULT_INSPECTOR_TOKEN_TTL_DAYS * 86_400_000;

/** Per-token request ceiling for authenticated inspector traffic (Section 32.6). */
export const DEFAULT_INSPECTOR_RATE_LIMIT_PER_MINUTE = 120;
/** Default failed-authentication budget, shared globally (Section 32.6). */
export const DEFAULT_INSPECTOR_UNAUTH_RATE_LIMIT_PER_MINUTE = 30;
/** The single key under which all failed inspector authentications are counted. */
export const INSPECTOR_UNAUTH_RATE_LIMIT_KEY = 'inspector-unauthenticated';

/** Why a token request was rejected at creation. */
export type InvalidInspectorTokenReason = 'empty_name' | 'past_expiry';

/** A request to issue a token. The plaintext is generated, not supplied. */
export interface InspectorTokenRequest {
  name: string;
  createdByUserId: string;
  /**
   * Absolute expiry (epoch ms). Must be in the future. When the field is absent
   * the token expires {@link DEFAULT_INSPECTOR_TOKEN_TTL_DAYS} days after
   * creation; an explicit `null` issues a non-expiring token (a deliberate
   * programmatic choice — the Discord command never sends `null`).
   */
  expiresAtMs?: number | null;
}

export interface CreateInspectorTokenDeps {
  db: DatabaseSync;
  nowMs: number;
}

export interface ResolveInspectorTokenDeps {
  db: DatabaseSync;
  nowMs: number;
}

export type CreateInspectorTokenOutcome =
  | { kind: 'invalid'; reason: InvalidInspectorTokenReason; detail: string }
  | { kind: 'created'; tokenId: string; token: string; row: SafeInspectorTokenRow };

/**
 * Result of authenticating a presented bearer value. `expired`, `revoked`, and
 * `invalid` all map to `401` at the HTTP layer; the kinds exist for server-side
 * logging only and carry no plaintext.
 */
export type ResolveInspectorTokenOutcome =
  | { kind: 'invalid' }
  | { kind: 'expired'; row: SafeInspectorTokenRow }
  | { kind: 'revoked'; row: SafeInspectorTokenRow }
  | { kind: 'valid'; row: SafeInspectorTokenRow };

/**
 * Generate a fresh 256-bit token value, base64url-encoded (43 chars, URL-safe
 * for an `Authorization: Bearer` header). The value is shown exactly once;
 * nothing here is persisted.
 */
export function generateInspectorTokenValue(bytes: number = INSPECTOR_TOKEN_BYTES): string {
  return randomBytes(bytes).toString('base64url');
}

/**
 * SHA-256 hex digest of the exact token string the client will send. This hash
 * — never the plaintext — is what `inspector_tokens.token_hash` stores, so a
 * stored row cannot be reversed into a usable credential.
 */
export function hashInspectorTokenValue(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Issue an inspector token. Validates name and expiry before any write, then
 * generates a 256-bit value, persists only its SHA-256 hash, and returns the
 * plaintext exactly once alongside the safe row. A request that omits
 * `expiresAtMs` gets the {@link DEFAULT_INSPECTOR_TOKEN_TTL_DAYS}-day default
 * so no issuance path can mint an eternal token by accident.
 */
export function createInspectorToken(
  deps: CreateInspectorTokenDeps,
  request: InspectorTokenRequest,
): CreateInspectorTokenOutcome {
  const name = (request.name ?? '').trim();
  if (name.length === 0) {
    return { kind: 'invalid', reason: 'empty_name', detail: 'a non-empty token name is required' };
  }
  if (request.expiresAtMs !== undefined && request.expiresAtMs !== null && request.expiresAtMs <= deps.nowMs) {
    return { kind: 'invalid', reason: 'past_expiry', detail: 'expires_at_ms must be in the future' };
  }
  const token = generateInspectorTokenValue();
  const tokenId = insertInspectorToken(deps.db, {
    tokenHash: hashInspectorTokenValue(token),
    name,
    createdByUserId: request.createdByUserId,
    createdAtMs: deps.nowMs,
    expiresAtMs:
      request.expiresAtMs === undefined ? deps.nowMs + DEFAULT_INSPECTOR_TOKEN_TTL_MS : request.expiresAtMs,
  });
  const row = getInspectorTokenByHash(deps.db, hashInspectorTokenValue(token));
  if (!row) {
    // Unreachable: the row was just inserted. Fail loudly without surfacing the
    // plaintext — the message carries no token-derived material.
    throw new Error('inspector token was not readable immediately after insert');
  }
  return { kind: 'created', tokenId, token, row };
}

/**
 * Authenticate a presented bearer value. The value is hashed and looked up by
 * `token_hash`; because the plaintext is never stored, this hash-and-lookup is
 * the only validation path. On success `last_used_at_ms` is touched. Mismatched,
 * expired, and revoked tokens yield their respective kinds; all three are `401`
 * to the client.
 */
export function resolveInspectorToken(
  deps: ResolveInspectorTokenDeps,
  presentedValue: string,
): ResolveInspectorTokenOutcome {
  if (typeof presentedValue !== 'string' || presentedValue.length === 0) return { kind: 'invalid' };
  const row = getInspectorTokenByHash(deps.db, hashInspectorTokenValue(presentedValue));
  if (!row) return { kind: 'invalid' };
  if (row.revokedAtMs !== null) return { kind: 'revoked', row };
  if (row.expiresAtMs !== null && row.expiresAtMs <= deps.nowMs) return { kind: 'expired', row };
  touchInspectorTokenLastUsed(deps.db, row.id, deps.nowMs);
  return { kind: 'valid', row };
}
